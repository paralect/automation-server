import { filterDirectory, SlackDirectoryError } from "@automation-server/api/slackDirectory";
import { createSlackBotClient, SlackApiError } from "@automation-server/automations";
export const DIRECTORY_TTL_MS = 60_000;
const MAX_CACHED = 64;
// What a person can do about each failure, shown verbatim in the admin.
const SCOPES = {
    users: "users:read",
    channels: "channels:read and groups:read",
};
export function createSlackDirectory({ resolve, fetch, now = Date.now, ttlMs = DIRECTORY_TTL_MS, maxCached = MAX_CACHED }) {
    // Insertion order doubles as age order, so the oldest entry is the first key.
    const cache = new Map();
    const fetchRows = async (kind, token, apiBaseUrl) => {
        const client = createSlackBotClient({ token, apiBaseUrl, fetch });
        try {
            const { items, truncated } = await (kind === "users" ? client.usersList() : client.channelsList());
            return { items: [...items], truncated };
        }
        catch (err) {
            if (!(err instanceof SlackApiError))
                throw err;
            if (err.code === "missing_scope")
                throw new SlackDirectoryError("missing-scope", `Slack says the app is missing a scope. Add the ${SCOPES[kind]} scope to the Slack app and reinstall it.`);
            if (err.code === "invalid_auth" || err.code === "token_revoked" || err.code === "not_authed" || err.code === "account_inactive") {
                throw new SlackDirectoryError("rejected", "Slack rejected the bot token. Check it under Connection.");
            }
            throw new SlackDirectoryError("failed", err.message);
        }
    };
    return {
        async list({ project, kind, search, refresh }) {
            const { slack } = resolve(project);
            const token = slack.values.botToken;
            if (!token)
                throw new SlackDirectoryError("no-token", "Save the bot token first.");
            const apiBaseUrl = slack.values.apiBaseUrl;
            const credential = `${token}\u0000${apiBaseUrl ?? ""}`;
            const key = `${project}\u0000${kind}`;
            const t = now();
            let entry = cache.get(key);
            if (!entry || refresh || entry.credential !== credential || t - entry.at >= ttlMs) {
                const rows = fetchRows(kind, token, apiBaseUrl);
                entry = { credential, at: t, rows };
                cache.delete(key);
                cache.set(key, entry);
                for (const oldest of cache.keys()) {
                    if (cache.size <= maxCached)
                        break;
                    cache.delete(oldest);
                }
                // A failure must not be served again for a minute.
                rows.catch(() => {
                    if (cache.get(key) === entry)
                        cache.delete(key);
                });
            }
            const { items, truncated } = await entry.rows;
            return { items: filterDirectory(items, search), truncated };
        },
    };
}

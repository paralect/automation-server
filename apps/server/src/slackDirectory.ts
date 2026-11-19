import { filterDirectory, SlackDirectoryError, type DirectoryKind, type DirectoryResult, type SlackDirectory } from "@automation-server/api/slackDirectory";
import { createSlackBotClient, SlackApiError } from "@automation-server/automations";
import type { ResolvedConfig } from "@automation-server/settings";

export const DIRECTORY_TTL_MS = 60_000;
const MAX_CACHED = 64;

export type SlackDirectoryDeps = {
  resolve: (project: string) => ResolvedConfig;
  fetch?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  maxCached?: number;
};

// What a person can do about each failure, shown verbatim in the admin.
const SCOPES: Record<DirectoryKind, string> = {
  users: "users:read",
  channels: "channels:read and groups:read",
};

type Entry = {
  // The token and base URL the rows were read with, so replacing the token never serves the old workspace's rows.
  readonly credential: string;
  readonly at: number;
  readonly rows: Promise<DirectoryResult>;
};

export function createSlackDirectory({ resolve, fetch, now = Date.now, ttlMs = DIRECTORY_TTL_MS, maxCached = MAX_CACHED }: SlackDirectoryDeps): SlackDirectory {
  // Insertion order doubles as age order, so the oldest entry is the first key.
  const cache = new Map<string, Entry>();

  const fetchRows = async (kind: DirectoryKind, token: string, apiBaseUrl: string | undefined): Promise<DirectoryResult> => {
    const client = createSlackBotClient({ token, apiBaseUrl, fetch });
    try {
      const { items, truncated } = await (kind === "users" ? client.usersList() : client.channelsList());
      return { items: [...items], truncated };
    } catch (err) {
      if (!(err instanceof SlackApiError)) throw err;
      if (err.code === "missing_scope") throw new SlackDirectoryError("missing-scope", `Slack says the app is missing a scope. Add the ${SCOPES[kind]} scope to the Slack app and reinstall it.`);
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
      if (!token) throw new SlackDirectoryError("no-token", "Save the bot token first.");
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
          if (cache.size <= maxCached) break;
          cache.delete(oldest);
        }
        // A failure must not be served again for a minute.
        rows.catch(() => {
          if (cache.get(key) === entry) cache.delete(key);
        });
      }
      const { items, truncated } = await entry.rows;
      return { items: filterDirectory(items, search), truncated };
    },
  };
}

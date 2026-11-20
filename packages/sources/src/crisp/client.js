import { z } from "zod";
const TIMEOUT_MS = 10_000;
const MESSAGES_PAGE_SIZE = 20;
const MAX_MESSAGE_PAGES = 5;
export const CRISP_API_BASE_URL = "https://api.crisp.chat/v1";
export class CrispApiError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.name = "CrispApiError";
        this.status = status;
    }
}
const envelope = (data) => z.object({ reason: z.string().optional(), data });
const websiteSchema = envelope(z.object({ name: z.string().nullish(), domain: z.string().nullish() }));
const conversationSchema = envelope(z.object({
    segments: z.array(z.string()).nullish(),
    meta: z.object({ email: z.string().nullish(), segments: z.array(z.string()).nullish() }).nullish(),
}));
const messagesSchema = envelope(z.array(z.object({
    type: z.string(),
    from: z.string(),
    content: z.unknown(),
    timestamp: z.number(),
})));
export function createCrispClient(options) {
    const base = (options.apiBaseUrl ?? CRISP_API_BASE_URL).replace(/\/+$/, "");
    const doFetch = options.fetch ?? fetch;
    const auth = `Basic ${Buffer.from(`${options.identifier}:${options.key}`).toString("base64")}`;
    const website = `/website/${encodeURIComponent(options.websiteId)}`;
    const conversation = (sessionId) => `${website}/conversation/${encodeURIComponent(sessionId)}`;
    async function call(method, path, body) {
        const endpoint = `${method} ${path.split("?")[0]}`;
        let res;
        try {
            res = await doFetch(`${base}${path}`, {
                method,
                headers: {
                    Authorization: auth,
                    "X-Crisp-Tier": "plugin",
                    Accept: "application/json",
                    "User-Agent": "automation-server",
                    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
        }
        catch {
            throw new Error(`Crisp API ${endpoint} failed: network error`);
        }
        const json = await res.json().catch(() => null);
        if (!res.ok) {
            const reason = json?.reason;
            const safe = typeof reason === "string" ? `: ${reason.slice(0, 100)}` : "";
            throw new CrispApiError(`Crisp API ${endpoint} failed with status ${res.status}${safe}`, res.status);
        }
        return json;
    }
    return {
        async website() {
            const parsed = websiteSchema.parse(await call("GET", website));
            return { name: parsed.data.name ?? parsed.data.domain ?? null };
        },
        async conversation(sessionId) {
            const { data } = conversationSchema.parse(await call("GET", conversation(sessionId)));
            return {
                email: data.meta?.email || null,
                segments: [...new Set([...(data.meta?.segments ?? []), ...(data.segments ?? [])])],
            };
        },
        async messages(sessionId) {
            const all = [];
            let before = null;
            for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
                const query = before === null ? "" : `?timestamp_before=${before}`;
                const batch = messagesSchema.parse(await call("GET", `${conversation(sessionId)}/messages${query}`)).data;
                all.push(...batch);
                if (batch.length === 0)
                    break;
                const oldest = batch.reduce((min, m) => Math.min(min, m.timestamp), Infinity);
                if (batch.length < MESSAGES_PAGE_SIZE || (before !== null && oldest >= before))
                    break;
                before = oldest;
            }
            return all;
        },
        async addNote(sessionId, content) {
            await call("POST", `${conversation(sessionId)}/message`, { type: "note", from: "operator", origin: "chat", content });
        },
        async setSegments(sessionId, segments) {
            await call("PATCH", `${conversation(sessionId)}/meta`, { segments });
        },
    };
}

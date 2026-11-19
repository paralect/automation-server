import { z } from "zod";

import { scrub } from "../posthogWeeklyReport/scrub";

export const SLACK_API = "https://slack.com/api";
const TIMEOUT_MS = 10_000;
const REPLIES_PAGE_SIZE = 200;
const REPLIES_MAX_PAGES = 5;
const MAX_REPLY_TEXT_CHARS = 4000;

// Slack treats <!channel> and <@U123> as live markup, so text that came from a person or a tool must never reach it unescaped.
export const escapeSlackText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export type SlackBotClientConfig = {
  token: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type SlackIdentity = {
  readonly botName: string;
  readonly botUserId: string;
  readonly team: string;
  readonly teamId: string;
};

export type PostMessage = {
  readonly channel: string;
  readonly threadTs: string;
  readonly text: string;
};

export type SlackThreadMessage = {
  readonly ts: string;
  readonly user: string | null;
  readonly botId: string | null;
  readonly text: string;
};

export type SlackBotClient = {
  authTest(): Promise<SlackIdentity>;
  // The newest `limit` messages of the thread, oldest first. Slack returns a thread oldest first, so this pages through it.
  replies(request: { channel: string; threadTs: string; limit: number }): Promise<readonly SlackThreadMessage[]>;
  postMessage(message: PostMessage): Promise<{ readonly ts: string }>;
};

export class SlackApiError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "SlackApiError";
  }
}

const envelope = z.object({ ok: z.boolean(), error: z.string().optional() }).loose();
const authTestBody = z.object({ user: z.string(), user_id: z.string(), team: z.string(), team_id: z.string() });
const postBody = z.object({ ts: z.string() });
const repliesBody = z.object({
  messages: z.array(
    z.object({ ts: z.string(), user: z.string().nullish(), bot_id: z.string().nullish(), text: z.string().nullish() }),
  ),
  response_metadata: z.object({ next_cursor: z.string().nullish() }).nullish(),
});

export function createSlackBotClient({ token, apiBaseUrl = SLACK_API, fetch: doFetch = fetch, timeoutMs = TIMEOUT_MS }: SlackBotClientConfig): SlackBotClient {
  const base = apiBaseUrl.replace(/\/+$/, "");
  const secrets = [token];
  const fail = (method: string, what: string, code: string | null = null): never => {
    throw new SlackApiError(`Slack ${method} failed: ${scrub(what, secrets)}`, code);
  };

  // Slack read methods such as conversations.replies only accept form encoding, not a JSON body.
  const call = async (method: string, body: Record<string, unknown>, form = false): Promise<Record<string, unknown>> => {
    let res: Response;
    try {
      res = await doFetch(`${base}/${method}`, {
        method: "POST",
        headers: {
          "content-type": form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8",
          authorization: `Bearer ${token}`,
        },
        body: form ? new URLSearchParams(Object.entries(body).map(([k, v]): [string, string] => [k, String(v)])).toString() : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch (err) {
      return fail(method, err instanceof Error && err.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : err instanceof Error ? err.message : String(err));
    }
    if (!res.ok) return fail(method, `HTTP ${res.status}`);
    const json = envelope.safeParse(await res.json().catch(() => null));
    if (!json.success) return fail(method, "unexpected response");
    if (!json.data.ok) return fail(method, json.data.error ?? "unknown error", json.data.error ?? null);
    return json.data;
  };

  return {
    async authTest() {
      const parsed = authTestBody.safeParse(await call("auth.test", {}));
      if (!parsed.success) return fail("auth.test", "unexpected response");
      const { user, user_id, team, team_id } = parsed.data;
      return { botName: user, botUserId: user_id, team, teamId: team_id };
    },
    async replies({ channel, threadTs, limit }) {
      const newest: SlackThreadMessage[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < REPLIES_MAX_PAGES; page++) {
        const parsed = repliesBody.safeParse(
          await call("conversations.replies", { channel, ts: threadTs, limit: REPLIES_PAGE_SIZE, ...(cursor ? { cursor } : {}) }, true),
        );
        if (!parsed.success) return fail("conversations.replies", "unexpected response");
        for (const m of parsed.data.messages) {
          newest.push({ ts: m.ts, user: m.user ?? null, botId: m.bot_id ?? null, text: (m.text ?? "").slice(0, MAX_REPLY_TEXT_CHARS) });
        }
        // Only the tail is kept, so memory stays at `limit` messages however long the thread is.
        if (newest.length > limit) newest.splice(0, newest.length - limit);
        cursor = parsed.data.response_metadata?.next_cursor || undefined;
        if (!cursor) break;
      }
      return newest;
    },
    async postMessage({ channel, threadTs, text }) {
      const parsed = postBody.safeParse(await call("chat.postMessage", { channel, thread_ts: threadTs, text }));
      if (!parsed.success) return fail("chat.postMessage", "unexpected response");
      return { ts: parsed.data.ts };
    },
  };
}

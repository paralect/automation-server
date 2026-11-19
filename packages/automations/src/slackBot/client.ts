import { z } from "zod";

import { scrub } from "../posthogWeeklyReport/scrub";

export const SLACK_API = "https://slack.com/api";
const TIMEOUT_MS = 10_000;

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

export type SlackBotClient = {
  authTest(): Promise<SlackIdentity>;
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

export function createSlackBotClient({ token, apiBaseUrl = SLACK_API, fetch: doFetch = fetch, timeoutMs = TIMEOUT_MS }: SlackBotClientConfig): SlackBotClient {
  const base = apiBaseUrl.replace(/\/+$/, "");
  const secrets = [token];
  const fail = (method: string, what: string, code: string | null = null): never => {
    throw new SlackApiError(`Slack ${method} failed: ${scrub(what, secrets)}`, code);
  };

  const call = async (method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    let res: Response;
    try {
      res = await doFetch(`${base}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
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
    async postMessage({ channel, threadTs, text }) {
      const parsed = postBody.safeParse(await call("chat.postMessage", { channel, thread_ts: threadTs, text }));
      if (!parsed.success) return fail("chat.postMessage", "unexpected response");
      return { ts: parsed.data.ts };
    },
  };
}

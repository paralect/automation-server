import { describe, expect, test } from "bun:test";

import { createSlackBotClient, SlackApiError } from "../src/slackBot/client";

const TOKEN = "xoxb-1234567890-ABCDEFGHIJ-secretsecret";

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown>; redirect: RequestInit["redirect"] };

const stub = (handler: (call: Call) => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)), redirect: init?.redirect };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fn, calls };
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("slack bot client", () => {
  test("auth.test returns the bot and team and sends the token only as a bearer header", async () => {
    const { fn, calls } = stub(() => json({ ok: true, user: "paralect-bot", user_id: "UBOT", team: "Paralect", team_id: "T1" }));
    const identity = await createSlackBotClient({ token: TOKEN, fetch: fn }).authTest();
    expect(identity).toEqual({ botName: "paralect-bot", botUserId: "UBOT", team: "Paralect", teamId: "T1" });
    expect(calls[0]!.url).toBe("https://slack.com/api/auth.test");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(calls[0]!.body)).not.toContain(TOKEN);
  });

  test("never follows a redirect, so the bearer token cannot be forwarded", async () => {
    const { fn, calls } = stub(() => json({ ok: true, ts: "1.2" }));
    await createSlackBotClient({ token: TOKEN, fetch: fn }).postMessage({ channel: "C1", threadTs: "1700.1", text: "hi" });
    expect(calls[0]!.redirect).toBe("error");
  });

  test("chat.postMessage posts into the thread", async () => {
    const { fn, calls } = stub(() => json({ ok: true, ts: "1.2" }));
    const sent = await createSlackBotClient({ token: TOKEN, fetch: fn }).postMessage({ channel: "C1", threadTs: "1700.1", text: "hi" });
    expect(sent).toEqual({ ts: "1.2" });
    expect(calls[0]!.url).toBe("https://slack.com/api/chat.postMessage");
    expect(calls[0]!.body).toEqual({ channel: "C1", thread_ts: "1700.1", text: "hi" });
  });

  test("apiBaseUrl overrides the host and tolerates a trailing slash", async () => {
    const { fn, calls } = stub(() => json({ ok: true, ts: "1.2" }));
    await createSlackBotClient({ token: TOKEN, fetch: fn, apiBaseUrl: "http://127.0.0.1:3199/api/" }).postMessage({ channel: "C", threadTs: "1", text: "x" });
    expect(calls[0]!.url).toBe("http://127.0.0.1:3199/api/chat.postMessage");
  });

  test("a Slack ok:false answer becomes a SlackApiError with the code", async () => {
    const { fn } = stub(() => json({ ok: false, error: "channel_not_found" }));
    const error = await createSlackBotClient({ token: TOKEN, fetch: fn }).postMessage({ channel: "C", threadTs: "1", text: "x" }).catch((e) => e);
    expect(error).toBeInstanceOf(SlackApiError);
    expect(error.code).toBe("channel_not_found");
    expect(error.message).toContain("channel_not_found");
  });

  test("a network error that echoes the token never leaks it", async () => {
    const { fn } = stub(() => {
      throw new Error(`connect failed for Bearer ${TOKEN} and ${TOKEN}`);
    });
    const error = await createSlackBotClient({ token: TOKEN, fetch: fn }).authTest().catch((e) => e);
    expect(error).toBeInstanceOf(SlackApiError);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain("secretsecret");
  });

  test("a non-2xx status and a malformed body are errors", async () => {
    const down = stub(() => json({}, 503));
    expect(await createSlackBotClient({ token: TOKEN, fetch: down.fn }).authTest().catch((e) => e.message)).toContain("HTTP 503");
    const odd = stub(() => new Response("<html>", { status: 200 }));
    expect(await createSlackBotClient({ token: TOKEN, fetch: odd.fn }).authTest().catch((e) => e.message)).toContain("unexpected response");
  });

  test("conversations.replies is a form-encoded call with the limit and maps bot and user authors", async () => {
    const seen: { body: string; type: string }[] = [];
    const fn = (async (_url: string, init?: RequestInit) => {
      seen.push({ body: String(init?.body), type: (init?.headers as Record<string, string>)["content-type"]! });
      return json({
        ok: true,
        messages: [
          { ts: "1.1", user: "U1", text: "hello" },
          { ts: "1.2", bot_id: "B1", text: "bot says" },
        ],
      });
    }) as unknown as typeof fetch;
    const out = await createSlackBotClient({ token: TOKEN, fetch: fn }).replies({ channel: "C1", threadTs: "1.1", limit: 20 });
    expect(seen[0]!.type).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(seen[0]!.body).get("limit")).toBe("200");
    expect(new URLSearchParams(seen[0]!.body).get("ts")).toBe("1.1");
    expect(seen[0]!.body).not.toContain(TOKEN);
    expect(out).toEqual([
      { ts: "1.1", user: "U1", botId: null, text: "hello" },
      { ts: "1.2", user: null, botId: "B1", text: "bot says" },
    ]);
  });

  const thread = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ ts: `${from + i}.0`, user: "U1", text: `m${from + i}` }));

  test("a long thread is paged with the cursor and only the newest messages are kept", async () => {
    const cursors: (string | null)[] = [];
    const pages: Record<string, { messages: unknown[]; next: string }> = {
      "": { messages: thread(1, 30), next: "c2" },
      c2: { messages: thread(31, 60), next: "c3" },
      c3: { messages: thread(61, 75), next: "" },
    };
    const fn = (async (_url: string, init?: RequestInit) => {
      const cursor = new URLSearchParams(String(init?.body)).get("cursor");
      cursors.push(cursor);
      const page = pages[cursor ?? ""]!;
      return json({ ok: true, messages: page.messages, response_metadata: { next_cursor: page.next } });
    }) as unknown as typeof fetch;
    const out = await createSlackBotClient({ token: TOKEN, fetch: fn }).replies({ channel: "C1", threadTs: "1.0", limit: 20 });
    expect(cursors).toEqual([null, "c2", "c3"]);
    expect(out.map((m) => m.text)).toEqual(thread(56, 75).map((m) => m.text));
  });

  test("paging stops after five pages even when Slack keeps offering a cursor", async () => {
    let calls = 0;
    const fn = (async () => {
      calls++;
      return json({ ok: true, messages: thread(calls, calls), response_metadata: { next_cursor: `c${calls}` } });
    }) as unknown as typeof fetch;
    const out = await createSlackBotClient({ token: TOKEN, fetch: fn }).replies({ channel: "C1", threadTs: "1.0", limit: 3 });
    expect(calls).toBe(5);
    expect(out.map((m) => m.text)).toEqual(["m3", "m4", "m5"]);
  });

  test("a huge message is cut so the kept window stays small", async () => {
    const fn = (async () => json({ ok: true, messages: [{ ts: "1.0", user: "U1", text: "x".repeat(50_000) }] })) as unknown as typeof fetch;
    const [only] = await createSlackBotClient({ token: TOKEN, fetch: fn }).replies({ channel: "C1", threadTs: "1.0", limit: 20 });
    expect(only!.text).toHaveLength(4000);
  });

  test("a hung request times out", async () => {
    const hang = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const error = await createSlackBotClient({ token: TOKEN, fetch: hang, timeoutMs: 20 }).authTest().catch((e) => e);
    expect(error.message).toContain("timed out after 20 ms");
  });
});

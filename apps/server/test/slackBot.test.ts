import { createDispatcher, createSqliteActivityStore, createSqliteStore, type Logger } from "@automation-server/core";
import { createSqliteSettingsStore, envFor, resolveConfig } from "@automation-server/settings";
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import { createRuntime } from "../src/runtime";
import { slack } from "../src/integrations/slack";
import { createWebhookRoutes } from "../src/webhooks";

const TOKEN = ["xoxb", "1111111111", "2222222222", "AbCdEfGhIjKlMnOpQrStUvWx"].join("-");
const SIGNING = "0123456789abcdef0123456789abcdef";
const HOOK = "https://hooks.slack.com/services/T000/B000/SECRETSECRET";
const BASE_ENV = { SLACK_BOT_TOKEN: TOKEN, SLACK_SIGNING_SECRET: SIGNING };

type SlackCall = { method: string; auth: string | null; body: Record<string, unknown> };

const setup = ({ botEnabled = true, allowed = ["UOK"], env = BASE_ENV }: { botEnabled?: boolean; allowed?: string[]; env?: Record<string, string> } = {}) => {
  const calls: SlackCall[] = [];
  const hookCalls: string[] = [];
  const logs: string[] = [];
  const log: Logger = {
    info: (m, f) => void logs.push(JSON.stringify({ m, f })),
    warn: (m, f) => void logs.push(JSON.stringify({ m, f })),
    error: (m, f) => void logs.push(JSON.stringify({ m, f })),
  };
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target === HOOK) {
      hookCalls.push(target);
      return new Response("ok");
    }
    const method = target.replace("https://slack.com/api/", "");
    const headers = init?.headers as Record<string, string>;
    calls.push({ method, auth: headers.authorization ?? null, body: JSON.parse(String(init?.body)) });
    if (method === "auth.test") return Response.json({ ok: true, user: "paralect-bot", user_id: "UBOT", team: "Paralect", team_id: "T1" });
    return Response.json({ ok: true, ts: "200.1" });
  }) as typeof globalThis.fetch;

  const settings = createSqliteSettingsStore({ path: ":memory:", encryptionKey: "k" });
  settings.project("default").apply({
    set: [
      { key: "slack.botEnabled", json: JSON.stringify(botEnabled), secret: false },
      { key: "slack.allowedUsers", json: JSON.stringify(allowed), secret: false },
    ],
  });
  const runtime = createRuntime({
    modules: [slack],
    projects: () => ["default"],
    resolve: (p) => resolveConfig(settings.project(p), envFor(p, env)),
    deps: { log, fetch },
  });
  const activity = createSqliteActivityStore({ path: ":memory:" });
  const dispatcher = createDispatcher({ automations: runtime.automations, store: createSqliteStore({ path: ":memory:" }), log, activity });
  const app = createWebhookRoutes({ source: runtime.source, defaultProject: "default", dispatcher, log });

  const mention = (patch: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
    type: "event_callback",
    team_id: "T1",
    event_id: "Ev1",
    authorizations: [{ user_id: "UBOT" }],
    event: { type: "app_mention", user: "UOK", text: "<@UBOT> hello team", ts: "100.1", channel: "C1", ...patch },
    ...top,
  });

  const deliver = (payload: unknown, { ts = Math.floor(Date.now() / 1000), secret = SIGNING, path = "/webhooks/slack" }: { ts?: number; secret?: string; path?: string } = {}) => {
    const body = JSON.stringify(payload);
    const signature = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
    return app.request(path, {
      method: "POST",
      body,
      headers: { "x-slack-request-timestamp": String(ts), "x-slack-signature": signature, "content-type": "application/json" },
    });
  };
  const unsigned = (payload: unknown) => app.request("/webhooks/slack", { method: "POST", body: JSON.stringify(payload) });
  const replies = () => calls.filter((c) => c.method === "chat.postMessage").map((c) => c.body);
  return { deliver, unsigned, mention, replies, calls, hookCalls, logs, dispatcher, runtime, activity };
};

describe("slack bot over the webhook route", () => {
  test("a listed user's signed mention gets a threaded reply", async () => {
    const t = setup();
    const res = await t.deliver(t.mention());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await t.dispatcher.drain(1000);
    expect(t.replies()).toEqual([{ channel: "C1", thread_ts: "100.1", text: "Got it: hello team" }]);
    expect(t.calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
  });

  test("Slack's retry of the same event_id runs once through the real claim", async () => {
    const t = setup();
    await t.deliver(t.mention());
    await t.deliver(t.mention());
    await t.deliver(t.mention());
    await t.dispatcher.drain(1000);
    expect(t.replies()).toHaveLength(1);
  });

  test("a different event_id is a new run", async () => {
    const t = setup();
    await t.deliver(t.mention());
    await t.deliver(t.mention({}, { event_id: "Ev2" }));
    await t.dispatcher.drain(1000);
    expect(t.replies()).toHaveLength(2);
  });

  test("an unlisted user gets exactly one denial", async () => {
    const t = setup();
    await t.deliver(t.mention({ user: "UNOPE" }));
    await t.deliver(t.mention({ user: "UNOPE" }));
    await t.dispatcher.drain(1000);
    expect(t.replies()).toEqual([{ channel: "C1", thread_ts: "100.1", text: "You are not allowed to use this bot. Ask an admin to add your member ID." }]);
  });

  test("the bot's own messages never trigger it", async () => {
    const t = setup();
    expect((await t.deliver(t.mention({ bot_id: "B1", user: undefined }, { event_id: "Ev3" }))).status).toBe(200);
    expect((await t.deliver(t.mention({ user: "UBOT" }, { event_id: "Ev4" }))).status).toBe(200);
    await t.dispatcher.drain(1000);
    expect(t.replies()).toEqual([]);
    expect(t.activity.queryRuns({ limit: 10 }).items).toEqual([]);
  });

  test("url_verification returns the challenge and starts nothing", async () => {
    const t = setup();
    const res = await t.deliver({ type: "url_verification", challenge: "abc123", token: "legacy" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "abc123" });
    await t.dispatcher.drain(500);
    expect(t.calls).toEqual([]);
  });

  test("url_verification with a bad signature is refused", async () => {
    const t = setup();
    const res = await t.deliver({ type: "url_verification", challenge: "abc123" }, { secret: "wrong" });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
  });

  test("a bad signature gives 401 and no run", async () => {
    const t = setup();
    const res = await t.deliver(t.mention(), { secret: "not-the-secret" });
    expect(res.status).toBe(401);
    await t.dispatcher.drain(500);
    expect(t.calls).toEqual([]);
    expect(t.activity.queryRuns({ limit: 10 }).items).toEqual([]);
  });

  test("a stale timestamp gives 401 and no run", async () => {
    const t = setup();
    const res = await t.deliver(t.mention(), { ts: Math.floor(Date.now() / 1000) - 6 * 60 });
    expect(res.status).toBe(401);
    await t.dispatcher.drain(500);
    expect(t.calls).toEqual([]);
  });

  test("missing signature headers give 401", async () => {
    const t = setup();
    const res = await t.unsigned(t.mention());
    expect(res.status).toBe(401);
    await t.dispatcher.drain(500);
    expect(t.calls).toEqual([]);
  });

  test("with the bot switched off the route does not exist", async () => {
    const t = setup({ botEnabled: false });
    expect((await t.deliver(t.mention())).status).toBe(404);
    expect(t.runtime.automations()).toEqual([]);
  });

  test("the token and signing secret never reach logs, replies or run records", async () => {
    const t = setup();
    await t.deliver(t.mention());
    await t.deliver(t.mention(), { secret: "x" });
    await t.deliver(t.mention({ user: "UNOPE" }, { event_id: "Ev5" }));
    await t.dispatcher.drain(1000);
    const everything = JSON.stringify([t.logs, t.replies(), t.activity.queryRuns({ limit: 50 }).items, t.activity.queryLogs({ limit: 50 }).items]);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain("AbCdEfGhIjKl");
    expect(everything).not.toContain(SIGNING);
    const stored = t.activity.queryRuns({ limit: 1 }).items[0]!;
    expect(JSON.stringify(t.activity.getRun(stored.id))).not.toContain(TOKEN);
  });

  test("alerts are unaffected: a bot-only project sends no webhook traffic", async () => {
    const t = setup();
    await t.deliver(t.mention());
    await t.dispatcher.drain(1000);
    expect(t.hookCalls).toEqual([]);
  });
});

describe("slack connection test", () => {
  test("bot only: shows the bot name and team from auth.test and posts no message", async () => {
    const t = setup();
    const result = await t.runtime.test("default", "slack");
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Bot @paralect-bot is connected to Paralect");
    expect(result.details).toMatchObject({ bot: "paralect-bot", team: "Paralect", botEnabled: "yes", allowedUsers: "1", signingSecret: "set" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(t.calls.map((c) => c.method)).toEqual(["auth.test"]);
    expect(t.hookCalls).toEqual([]);
  });

  test("bot and webhook: runs auth.test and the webhook post", async () => {
    const t = setup({ env: { ...BASE_ENV, SLACK_ALERTS_WEBHOOK_URL: HOOK } });
    const result = await t.runtime.test("default", "slack");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Bot @paralect-bot");
    expect(result.message).toContain("Test message sent to Slack");
    expect(t.hookCalls).toEqual([HOOK]);
  });

  test("a rejected token comes back as not ok without the token", async () => {
    const t = setup({ env: BASE_ENV });
    const failing = createRuntime({
      modules: [slack],
      projects: () => ["default"],
      resolve: () => resolveConfig({ all: () => ({}) }, BASE_ENV),
      deps: { log: { info() {}, warn() {}, error() {} }, fetch: (async () => Response.json({ ok: false, error: `invalid_auth ${TOKEN}` })) as unknown as typeof fetch },
    });
    const result = await failing.test("default", "slack");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("invalid_auth");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(t.calls).toEqual([]);
  });
});

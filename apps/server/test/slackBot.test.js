import { createDispatcher, createSqliteActivityStore, createSqlitePendingActionStore, createSqliteStore } from "@automation-server/core";
import { createSqliteSettingsStore, envFor, resolveConfig } from "@automation-server/settings";
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { NOT_CONFIGURED_REPLY } from "@automation-server/automations";
import { createRuntime } from "../src/runtime";
import { slack } from "../src/integrations/slack";
import { createWebhookRoutes } from "../src/webhooks";
const TOKEN = ["xoxb", "1111111111", "2222222222", "AbCdEfGhIjKlMnOpQrStUvWx"].join("-");
const SIGNING = "0123456789abcdef0123456789abcdef";
const HOOK = "https://hooks.slack.com/services/T000/B000/SECRETSECRET";
const BASE_ENV = { SLACK_BOT_TOKEN: TOKEN, SLACK_SIGNING_SECRET: SIGNING };
const setup = ({ botEnabled = true, allowed = ["UOK"], env = BASE_ENV, model = [], withPending = false, extraSettings = [], } = {}) => {
    const linearWrites = [];
    const calls = [];
    const modelRequests = [];
    const withModel = model.length > 0;
    const hookCalls = [];
    const logs = [];
    const log = {
        info: (m, f) => void logs.push(JSON.stringify({ m, f })),
        warn: (m, f) => void logs.push(JSON.stringify({ m, f })),
        error: (m, f) => void logs.push(JSON.stringify({ m, f })),
    };
    const fetch = (async (url, init) => {
        const target = String(url);
        if (target === HOOK) {
            hookCalls.push(target);
            return new Response("ok");
        }
        if (target === "https://openrouter.ai/api/v1/chat/completions") {
            const request = JSON.parse(String(init?.body));
            modelRequests.push({ system: request.messages[0].content, user: request.messages[1].content });
            const step = model.shift();
            return step ? Response.json({ choices: [{ message: { content: JSON.stringify(step) } }] }) : new Response("{}", { status: 500 });
        }
        if (target === "https://api.linear.app/graphql") {
            const { query } = JSON.parse(String(init?.body));
            if (query.includes("teams("))
                return Response.json({ data: { teams: { nodes: [{ id: "T1", key: "ENG" }] } } });
            if (query.includes("issueCreate")) {
                linearWrites.push(query);
                return Response.json({ data: { issueCreate: { success: true, issue: { identifier: "ENG-9", title: "Billing bug", url: "https://linear.app/x/ENG-9", state: null, assignee: null } } } });
            }
            return Response.json({
                data: { searchIssues: { nodes: [{ identifier: "ENG-1", title: "Billing <!channel> fails", url: "https://linear.app/x/ENG-1", state: { name: "Todo" }, assignee: null }] } },
            });
        }
        const method = target.replace("https://slack.com/api/", "");
        const headers = init?.headers;
        calls.push({ method, auth: headers.authorization ?? null, body: JSON.parse(String(init?.body)) });
        if (method === "auth.test")
            return Response.json({ ok: true, user: "paralect-bot", user_id: "UBOT", team: "Paralect", team_id: "T1" });
        return Response.json({ ok: true, ts: "200.1" });
    });
    const settings = createSqliteSettingsStore({ path: ":memory:", encryptionKey: "k" });
    settings.project("default").apply({
        set: [
            { key: "slack.botEnabled", json: JSON.stringify(botEnabled), secret: false },
            { key: "slack.allowedUsers", json: JSON.stringify(allowed), secret: false },
            ...(withModel ? [{ key: "openrouter.apiKey", json: JSON.stringify("sk-or-test-key-0123456789"), secret: true }] : []),
            ...extraSettings,
        ],
    });
    const runtime = createRuntime({
        modules: [slack],
        projects: () => ["default"],
        resolve: (p) => resolveConfig(settings.project(p), envFor(p, env)),
        deps: { log, fetch, ...(withPending ? { pending: createSqlitePendingActionStore({ path: ":memory:" }) } : {}) },
    });
    const activity = createSqliteActivityStore({ path: ":memory:" });
    const dispatcher = createDispatcher({ automations: runtime.automations, store: createSqliteStore({ path: ":memory:" }), log, activity });
    const app = createWebhookRoutes({ source: runtime.source, defaultProject: "default", dispatcher, log });
    const mention = (patch = {}, top = {}) => ({
        type: "event_callback",
        team_id: "T1",
        event_id: "Ev1",
        authorizations: [{ user_id: "UBOT" }],
        event: { type: "app_mention", user: "UOK", text: "<@UBOT> hello team", ts: "100.1", channel: "C1", ...patch },
        ...top,
    });
    const deliver = (payload, { ts = Math.floor(Date.now() / 1000), secret = SIGNING, path = "/webhooks/slack" } = {}) => {
        const body = JSON.stringify(payload);
        const signature = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
        return app.request(path, {
            method: "POST",
            body,
            headers: { "x-slack-request-timestamp": String(ts), "x-slack-signature": signature, "content-type": "application/json" },
        });
    };
    const unsigned = (payload) => app.request("/webhooks/slack", { method: "POST", body: JSON.stringify(payload) });
    const replies = () => calls.filter((c) => c.method === "chat.postMessage").map((c) => c.body);
    return { deliver, unsigned, mention, replies, calls, hookCalls, logs, dispatcher, runtime, activity, modelRequests, linearWrites };
};
describe("slack bot over the webhook route", () => {
    test("a listed user's signed mention gets a threaded reply, and without OpenRouter the bot says so", async () => {
        const t = setup();
        const res = await t.deliver(t.mention());
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        await t.dispatcher.drain(1000);
        expect(t.replies()).toEqual([{ channel: "C1", thread_ts: "100.1", text: NOT_CONFIGURED_REPLY }]);
        expect(t.calls[0].auth).toBe(`Bearer ${TOKEN}`);
        expect(t.activity.queryRuns({ limit: 1 }).items[0].status).toBe("succeeded");
    });
    test("with OpenRouter and a Linear key the model sees only the Linear tools, calls one, and the reply is escaped", async () => {
        const t = setup({
            env: { ...BASE_ENV, LINEAR_API_KEY: "lin_api_secretsecretsecret" },
            model: [
                { type: "tool", tool: "linear.searchIssues", argsJson: '{"query":"billing"}', text: null },
                { type: "final", tool: null, argsJson: null, text: "ENG-1 <!channel> is about billing" },
            ],
        });
        await t.deliver(t.mention({ text: "<@UBOT> what Linear issues mention billing?" }));
        await t.dispatcher.drain(1000);
        expect(t.replies()).toEqual([{ channel: "C1", thread_ts: "100.1", text: "ENG-1 &lt;!channel&gt; is about billing" }]);
        const system = t.modelRequests[0].system;
        expect(system).toContain("linear.searchIssues");
        for (const absent of ["github.", "sentry.", "posthog."])
            expect(system).not.toContain(absent);
        expect(t.modelRequests[1].user).toContain("Billing ‹!channel› fails");
        const everything = JSON.stringify([t.logs, t.replies(), t.activity.queryLogs({ limit: 50 }).items]);
        expect(everything).not.toContain("lin_api_secretsecretsecret");
        expect(everything).not.toContain("sk-or-test-key");
    });
    test("an unlisted user never reaches the model", async () => {
        const t = setup({ model: [{ type: "final", tool: null, argsJson: null, text: "should not run" }] });
        await t.deliver(t.mention({ user: "UNOPE" }));
        await t.dispatcher.drain(1000);
        expect(t.modelRequests).toEqual([]);
        expect(t.replies()).toHaveLength(1);
    });
    test("with allowed channels set, a mention elsewhere is ignored silently and a listed channel is answered", async () => {
        const t = setup({ extraSettings: [{ key: "slack.allowedChannels", json: '["CGOOD"]', secret: false }], model: [{ type: "final", tool: null, argsJson: null, text: "should not run" }] });
        await t.deliver(t.mention({ channel: "CELSE" }, { event_id: "Ev1" }));
        await t.deliver(t.mention({ channel: "CELSE", user: "UNOPE" }, { event_id: "Ev2" }));
        await t.dispatcher.drain(1000);
        expect(t.replies()).toEqual([]);
        expect(t.modelRequests).toEqual([]);
        expect(t.calls).toEqual([]);
        const decisions = t.activity.queryRuns({ limit: 10 }).items.map((r) => (t.activity.getRun(r.id)?.run.outcome).decision);
        expect(decisions).toEqual(["channel-not-allowed", "channel-not-allowed"]);
        await t.deliver(t.mention({ channel: "CGOOD" }, { event_id: "Ev3" }));
        await t.dispatcher.drain(1000);
        expect(t.replies().map((r) => r.channel)).toEqual(["CGOOD"]);
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
        expect(t.replies()).toEqual([{ channel: "C1", thread_ts: "100.1", text: "You are not allowed to use this bot. Ask an admin to add you to the allowed users." }]);
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
        const stored = t.activity.queryRuns({ limit: 1 }).items[0];
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
            deps: { log: { info() { }, warn() { }, error() { } }, fetch: (async () => Response.json({ ok: false, error: `invalid_auth ${TOKEN}` })) },
        });
        const result = await failing.test("default", "slack");
        expect(result.ok).toBe(false);
        expect(result.message).toContain("invalid_auth");
        expect(JSON.stringify(result)).not.toContain(TOKEN);
        expect(t.calls).toEqual([]);
    });
});
describe("slack bot changes over the webhook route", () => {
    const writeEnv = { ...BASE_ENV, LINEAR_API_KEY: "lin_api_secretsecretsecret" };
    const propose = { type: "tool", tool: "linear.createIssue", argsJson: '{"title":"Billing bug"}', text: null };
    test("without a pending store the model is not offered write tools", async () => {
        const t = setup({ env: writeEnv, model: [{ type: "final", tool: null, argsJson: null, text: "ok" }] });
        await t.deliver(t.mention());
        await t.dispatcher.drain(1000);
        expect(t.modelRequests[0].system).not.toContain("linear.createIssue");
    });
    test("with a pending store the write is offered, held for approval, and runs once after the requester approves", async () => {
        const t = setup({ env: writeEnv, withPending: true, model: [propose] });
        await t.deliver(t.mention({ text: "<@UBOT> create a ticket for the billing bug" }));
        await t.dispatcher.drain(1000);
        expect(t.modelRequests[0].system).toContain("linear.createIssue (write)");
        expect(t.linearWrites).toHaveLength(0);
        expect(t.replies()[0].text).toContain("Only <@UOK> can approve.");
        await t.deliver(t.mention({ text: "<@UBOT> approve", ts: "100.2", thread_ts: "100.1" }, { event_id: "Ev2" }));
        await t.dispatcher.drain(1000);
        expect(t.linearWrites).toHaveLength(1);
        expect(t.replies()[1].text).toBe('Done. Created Linear issue ENG-9 "Billing bug": https://linear.app/x/ENG-9');
        await t.deliver(t.mention({ text: "<@UBOT> approve", ts: "100.3", thread_ts: "100.1" }, { event_id: "Ev3" }));
        await t.dispatcher.drain(1000);
        expect(t.linearWrites).toHaveLength(1);
        expect(t.replies()[2].text).toBe("Nothing is waiting for approval in this thread.");
    });
    test("requireApproval is a Slack setting that can be switched off", async () => {
        const off = setup({
            env: writeEnv,
            withPending: true,
            model: [propose],
            extraSettings: [{ key: "slack.requireApproval", json: "false", secret: false }],
        });
        await off.deliver(off.mention());
        await off.dispatcher.drain(1000);
        expect(off.linearWrites).toHaveLength(1);
        expect(off.logs.some((l) => l.includes("approval is off"))).toBe(true);
    });
});

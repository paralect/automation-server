import { createScheduler, createSqliteActivityStore, createSqliteStore } from "@automation-server/core";
import { createSqliteHealthStore, createSqliteSettingsStore, envFor, resolveConfig } from "@automation-server/settings";
import { describe, expect, test } from "bun:test";
import { createAlertNotifier } from "../src/alerts";
import { createHealthSink, TOKEN_HEALTH_JOB } from "../src/health";
import { INTEGRATION_MODULES } from "../src/integrations/registry";
import { createRuntime } from "../src/runtime";
const HOOK = "https://hooks.slack.com/services/T000/B000/SECRETSECRET";
const GH_TOKEN = "ghp_healthSecretToken1234567890";
const DAY = 86_400_000;
const NOW = new Date("2026-11-17T06:00:00Z");
const log = { info() { }, warn() { }, error() { } };
const setup = ({ env = {}, adminUrl } = {}) => {
    const world = { githubStatus: 200, githubExpiry: undefined, slackAuth: "ok" };
    const slackApi = [];
    const posted = [];
    const fetch = (async (input, init) => {
        const url = new URL(String(input));
        if (url.hostname === "hooks.slack.com") {
            posted.push({ url: url.href, text: JSON.parse(String(init?.body)).text });
            return new Response("ok");
        }
        if (url.hostname === "slack.com") {
            slackApi.push(url.pathname);
            return Response.json(world.slackAuth === "ok" ? { ok: true, user: "bot", user_id: "UBOT", team: "Acme", team_id: "T1" } : { ok: false, error: "invalid_auth" });
        }
        if (world.githubStatus !== 200)
            return new Response("{}", { status: world.githubStatus });
        return url.pathname === "/user"
            ? Response.json({ login: "octo" }, { headers: world.githubExpiry ? { "github-authentication-token-expiration": world.githubExpiry } : {} })
            : Response.json({ private: false });
    });
    const settings = createSqliteSettingsStore({ path: ":memory:", encryptionKey: "k" });
    const resolve = (p) => resolveConfig(settings.project(p), envFor(p, { GITHUB_TOKEN: GH_TOKEN, SLACK_ALERTS_WEBHOOK_URL: HOOK, ...env }));
    const healthStore = createSqliteHealthStore({ path: ":memory:" });
    const activity = createSqliteActivityStore({ path: ":memory:" });
    const { notifyHealth } = createAlertNotifier({ resolve, activity, log, fetch, adminUrl, health: healthStore });
    const runtime = createRuntime({
        modules: INTEGRATION_MODULES,
        projects: () => ["default"],
        resolve,
        deps: { log, fetch },
        health: createHealthSink({ store: healthStore, notify: notifyHealth }),
    });
    const job = runtime.project("default").jobs.find((j) => j.name === TOKEN_HEALTH_JOB);
    const runJob = (now) => job.run({ log, key: job.due(now) ?? "", now });
    return { world, posted, slackApi, runtime, healthStore, activity, job, runJob, settings };
};
const expiryIn = (days, from = NOW) => new Date(from.getTime() + days * DAY).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
describe("token-health job", () => {
    test("is due once a day from 06:00 UTC, under one key per UTC date", () => {
        const { job } = setup();
        expect(job.due(new Date("2026-11-17T05:59:59Z"))).toBeNull();
        expect(job.due(new Date("2026-11-17T06:00:00Z"))).toBe("2026-11-17");
        expect(job.due(new Date("2026-11-17T23:59:59Z"))).toBe("2026-11-17");
        expect(job.due(new Date("2026-11-18T06:00:00Z"))).toBe("2026-11-18");
    });
    test("the runtime registers it per project and tests only configured integrations whose scheduled check applies", async () => {
        const { runJob, healthStore, runtime, posted } = setup();
        expect(runtime.project("default").jobs.map((j) => j.name)).toContain(TOKEN_HEALTH_JOB);
        await runJob(NOW);
        expect(posted).toEqual([]);
        expect(Object.keys(healthStore.get("default")).sort()).toEqual(["github"]);
        expect(healthStore.get("default").github).toMatchObject({ ok: true, checkedAt: NOW.toISOString() });
    });
    test("a project with a bot token gets auth.test in the daily run, and the webhook test message is never posted", async () => {
        const { runJob, healthStore, posted, slackApi } = setup({ env: { SLACK_BOT_TOKEN: "xoxb-1-2-AbCdEfGhIjKlMnOpQrStUv", SLACK_SIGNING_SECRET: "s" } });
        await runJob(NOW);
        expect(slackApi).toEqual(["/api/auth.test"]);
        expect(posted).toEqual([]);
        expect(Object.keys(healthStore.get("default")).sort()).toEqual(["github", "slack"]);
        expect(healthStore.get("default").slack).toMatchObject({ ok: true });
    });
    test("a bot-only project with no alert webhook is checked too, and a rejected bot token is recorded", async () => {
        const t = setup({ env: { SLACK_ALERTS_WEBHOOK_URL: "", SLACK_BOT_TOKEN: "xoxb-1-2-AbCdEfGhIjKlMnOpQrStUv", SLACK_SIGNING_SECRET: "s" } });
        t.world.slackAuth = "invalid_auth";
        await t.runJob(NOW);
        expect(t.healthStore.get("default").slack).toMatchObject({ ok: false });
        expect(t.posted).toEqual([]);
    });
    test("a rejected bot token alerts through the alert webhook without posting the test message", async () => {
        const t = setup({ env: { SLACK_BOT_TOKEN: "xoxb-1-2-AbCdEfGhIjKlMnOpQrStUv", SLACK_SIGNING_SECRET: "s" } });
        t.world.slackAuth = "invalid_auth";
        await t.runJob(NOW);
        expect(t.posted).toHaveLength(1);
        expect(t.posted[0].text).toContain("Slack");
        expect(t.posted[0].text).not.toContain("Automation server alerts are connected");
    });
    test("a webhook-only Slack stays out of the daily run", async () => {
        const { runJob, healthStore, slackApi } = setup();
        await runJob(NOW);
        expect(slackApi).toEqual([]);
        expect(healthStore.get("default").slack).toBeUndefined();
    });
    test("a run through the scheduler is recorded like any other job", async () => {
        const { job, activity } = setup();
        const scheduler = createScheduler({ jobs: () => [job], store: createSqliteStore({ path: ":memory:" }), log, activity });
        expect(await scheduler.runNow(TOKEN_HEALTH_JOB, "2026-11-17")).toMatchObject({ status: "succeeded" });
        expect(activity.queryRuns({ limit: 5 }).items.map((r) => [r.automation, r.status])).toEqual([[TOKEN_HEALTH_JOB, "succeeded"]]);
    });
});
describe("token health alerts", () => {
    test("ok to failing alerts once, stays quiet while it stays failing, and alerts again after a recovery", async () => {
        const t = setup({ adminUrl: "https://admin.example.com" });
        await t.runJob(NOW);
        expect(t.posted).toEqual([]);
        t.world.githubStatus = 401;
        await t.runJob(new Date(NOW.getTime() + DAY));
        expect(t.posted).toHaveLength(1);
        expect(t.posted[0].text).toContain("GitHub");
        expect(t.posted[0].text).toContain("https://admin.example.com/integrations/github");
        await t.runJob(new Date(NOW.getTime() + 2 * DAY));
        expect(t.posted).toHaveLength(1);
        t.world.githubStatus = 200;
        await t.runJob(new Date(NOW.getTime() + 3 * DAY));
        t.world.githubStatus = 401;
        await t.runJob(new Date(NOW.getTime() + 4 * DAY));
        expect(t.posted).toHaveLength(2);
    });
    test("a first-ever check that already fails alerts once", async () => {
        const t = setup();
        t.world.githubStatus = 401;
        await t.runJob(NOW);
        await t.runJob(new Date(NOW.getTime() + DAY));
        expect(t.posted).toHaveLength(1);
    });
    test("an expiry within 14 days alerts once per expiry date, and a new expiry alerts again", async () => {
        const t = setup();
        t.world.githubExpiry = expiryIn(5);
        await t.runJob(NOW);
        expect(t.posted).toHaveLength(1);
        expect(t.posted[0].text).toContain("expires soon");
        expect(t.posted[0].text).toContain("in 5 days");
        await t.runJob(new Date(NOW.getTime() + DAY));
        expect(t.posted).toHaveLength(1);
        t.world.githubExpiry = expiryIn(9);
        await t.runJob(new Date(NOW.getTime() + 2 * DAY));
        expect(t.posted).toHaveLength(2);
    });
    test("an expiry further than 14 days away is quiet", async () => {
        const t = setup();
        t.world.githubExpiry = expiryIn(15);
        await t.runJob(NOW);
        expect(t.posted).toEqual([]);
    });
    test("an already expired token alerts once, even after the 14 day warning went out", async () => {
        const t = setup();
        t.world.githubExpiry = expiryIn(2);
        await t.runJob(NOW);
        expect(t.posted).toHaveLength(1);
        const later = new Date(NOW.getTime() + 3 * DAY);
        await t.runJob(later);
        expect(t.posted).toHaveLength(2);
        expect(t.posted[1].text).toContain("has expired");
        await t.runJob(new Date(later.getTime() + DAY));
        expect(t.posted).toHaveLength(2);
    });
    test("a failing check on an expired token is one message", async () => {
        const t = setup();
        t.world.githubExpiry = expiryIn(-1);
        t.world.githubStatus = 401;
        await t.runJob(NOW);
        expect(t.posted).toHaveLength(1);
    });
    test("alertOnTokenHealth off, or slack not configured, posts nothing", async () => {
        const off = setup();
        off.settings.project("default").apply({ set: [{ key: "slack.alertOnTokenHealth", json: "false", secret: false }] });
        off.world.githubStatus = 401;
        await off.runJob(NOW);
        expect(off.posted).toEqual([]);
        const none = setup({ env: { SLACK_ALERTS_WEBHOOK_URL: "" } });
        none.world.githubStatus = 401;
        await none.runJob(NOW);
        expect(none.posted).toEqual([]);
    });
    test("a message never carries the token or the webhook url", async () => {
        const t = setup();
        t.world.githubStatus = 401;
        await t.runJob(NOW);
        const text = t.posted.map((p) => p.text).join("\n");
        expect(text).not.toContain(GH_TOKEN);
        expect(text).not.toContain("SECRETSECRET");
    });
    test("the manual test also persists and alerts, so the job does not repeat it", async () => {
        const t = setup();
        await t.runtime.test("default", "github", NOW);
        t.world.githubStatus = 401;
        await t.runtime.test("default", "github", new Date(NOW.getTime() + 1000));
        expect(t.posted).toHaveLength(1);
        await t.runJob(new Date(NOW.getTime() + DAY));
        expect(t.posted).toHaveLength(1);
    });
});

import { createScheduler, createSqliteActivityStore, createSqliteStore, type Job, type Logger } from "@automation-server/core";
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

const log: Logger = { info() {}, warn() {}, error() {} };

type World = { githubStatus: number; githubExpiry: string | undefined };

const setup = ({ env = {}, adminUrl }: { env?: Record<string, string>; adminUrl?: string } = {}) => {
  const world: World = { githubStatus: 200, githubExpiry: undefined };
  const posted: { url: string; text: string }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "hooks.slack.com") {
      posted.push({ url: url.href, text: (JSON.parse(String(init?.body)) as { text: string }).text });
      return new Response("ok");
    }
    if (world.githubStatus !== 200) return new Response("{}", { status: world.githubStatus });
    return url.pathname === "/user"
      ? Response.json({ login: "octo" }, { headers: world.githubExpiry ? { "github-authentication-token-expiration": world.githubExpiry } : {} })
      : Response.json({ private: false });
  }) as typeof globalThis.fetch;
  const settings = createSqliteSettingsStore({ path: ":memory:", encryptionKey: "k" });
  const resolve = (p: string) => resolveConfig(settings.project(p), envFor(p, { GITHUB_TOKEN: GH_TOKEN, SLACK_ALERTS_WEBHOOK_URL: HOOK, ...env }));
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
  const job = runtime.project("default").jobs.find((j) => j.name === TOKEN_HEALTH_JOB) as Job;
  const runJob = (now: Date) => job.run({ log, key: job.due(now) ?? "", now });
  return { world, posted, runtime, healthStore, activity, job, runJob, settings };
};

const expiryIn = (days: number, from = NOW) => new Date(from.getTime() + days * DAY).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");

describe("token-health job", () => {
  test("is due once a day from 06:00 UTC, under one key per UTC date", () => {
    const { job } = setup();
    expect(job.due(new Date("2026-11-17T05:59:59Z"))).toBeNull();
    expect(job.due(new Date("2026-11-17T06:00:00Z"))).toBe("2026-11-17");
    expect(job.due(new Date("2026-11-17T23:59:59Z"))).toBe("2026-11-17");
    expect(job.due(new Date("2026-11-18T06:00:00Z"))).toBe("2026-11-18");
  });

  test("the runtime registers it per project and tests only configured integrations whose test has no side effects", async () => {
    const { runJob, healthStore, runtime, posted } = setup();
    expect(runtime.project("default").jobs.map((j) => j.name)).toContain(TOKEN_HEALTH_JOB);
    await runJob(NOW);
    expect(posted).toEqual([]);
    expect(Object.keys(healthStore.get("default")).sort()).toEqual(["github"]);
    expect(healthStore.get("default").github).toMatchObject({ ok: true, checkedAt: NOW.toISOString() });
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
    expect(t.posted[0]!.text).toContain("GitHub");
    expect(t.posted[0]!.text).toContain("https://admin.example.com/integrations/github");
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
    expect(t.posted[0]!.text).toContain("expires soon");
    expect(t.posted[0]!.text).toContain("in 5 days");
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
    expect(t.posted[1]!.text).toContain("has expired");
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

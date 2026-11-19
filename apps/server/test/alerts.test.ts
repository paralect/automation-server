import { defineAutomation, createDispatcher, createSqliteActivityStore, createSqliteStore, type Automation, type Event, type Logger } from "@automation-server/core";
import { createSqliteHealthStore, createSqliteSettingsStore, envFor, resolveConfig } from "@automation-server/settings";
import { describe, expect, test } from "bun:test";

import { createAlertNotifier } from "../src/alerts";

const HOOK = "https://hooks.slack.com/services/T000/B000/SECRETSECRET";
const PROJECT = "acme";

type Posted = { url: string; text: string };

const setup = ({ env = { SLACK_ALERTS_WEBHOOK_URL: HOOK }, threshold = 3, slackStatus = 200, adminUrl }: { env?: Record<string, string>; threshold?: number; slackStatus?: number; adminUrl?: string } = {}) => {
  const slack = { status: slackStatus };
  const posted: Posted[] = [];
  const logged: string[] = [];
  const log: Logger = {
    info: (m, f) => void logged.push(JSON.stringify({ m, f })),
    warn: (m, f) => void logged.push(JSON.stringify({ m, f })),
    error: (m, f) => void logged.push(JSON.stringify({ m, f })),
  };
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    posted.push({ url: String(url), text: (JSON.parse(String(init?.body)) as { text: string }).text });
    return new Response(slack.status === 200 ? "ok" : `rejected ${HOOK}`, { status: slack.status });
  }) as typeof globalThis.fetch;
  const settings = createSqliteSettingsStore({ path: ":memory:", encryptionKey: "k" });
  settings.project(PROJECT).apply({ set: [{ key: "slack.failureThreshold", json: String(threshold), secret: false }] });
  const activity = createSqliteActivityStore({ path: ":memory:" });
  const resolve = (project: string) => resolveConfig(settings.project(project), project === PROJECT ? env : envFor(project, {}));
  const healthStore = createSqliteHealthStore({ path: ":memory:" });
  const { onRunFinished: notify, notifyHealth } = createAlertNotifier({ resolve, activity, log, fetch, adminUrl, health: healthStore });
  const dispatcher = createDispatcher({ automations: () => automations, store: createSqliteStore({ path: ":memory:" }), log, activity, onRunFinished: notify });
  const automations: Automation[] = [];
  return { slack, posted, logged, activity, notify, notifyHealth, healthStore, settings, dispatcher, automations };
};

let failing = true;
const inProject = (automation: Automation): Automation => ({ ...automation, project: PROJECT });

const flaky = inProject(
  defineAutomation({
    name: "flaky",
    matches: (e): e is Event => e.kind === "thing",
    run: async () => {
      if (failing) throw new Error("boom token=abc123def456");
    },
  }),
);

const event = (externalId: string): Event => ({ project: PROJECT, source: "test", kind: "thing", externalId, receivedAt: "2026-01-01T00:00:00Z", payload: {} });

const feed = async (t: ReturnType<typeof setup>, ids: string[], ok = false) => {
  failing = !ok;
  for (const id of ids) {
    t.dispatcher.enqueue(event(id));
    await t.dispatcher.drain(1000);
  }
};

const withFlaky = () => {
  const t = setup();
  t.automations.push(flaky);
  return t;
};

describe("failure alerts", () => {
  test("below the threshold nothing is posted", async () => {
    const t = withFlaky();
    await feed(t, ["1", "2"]);
    expect(t.posted).toEqual([]);
  });

  test("posts once when the streak reaches the threshold and not again for the next failure", async () => {
    const t = withFlaky();
    await feed(t, ["1", "2", "3", "4", "5"]);
    expect(t.posted).toHaveLength(1);
    expect(t.posted[0]!.url).toBe(HOOK);
    expect(t.posted[0]!.text).toContain("flaky");
    expect(t.posted[0]!.text).toContain("3 times in a row");
    expect(t.posted[0]!.text).toContain(PROJECT);
    expect(t.posted[0]!.text).not.toContain("abc123def456");
  });

  test("a success resets the streak so the next streak alerts again", async () => {
    const t = withFlaky();
    await feed(t, ["1", "2", "3"]);
    await feed(t, ["4"], true);
    await feed(t, ["5", "6"]);
    expect(t.posted).toHaveLength(1);
    await feed(t, ["7"]);
    expect(t.posted).toHaveLength(2);
  });

  test("duplicates and dry runs neither post nor count", async () => {
    const t = withFlaky();
    await feed(t, ["ok"], true);
    await feed(t, ["ok"], true);
    await feed(t, ["1", "2"]);
    for (const id of ["a", "b", "c"]) {
      const started = await t.dispatcher.replay({ project: PROJECT, automation: "flaky", event: event(id), replayOf: "x", dryRun: true });
      expect(started.outcome).toBe("started");
    }
    await t.dispatcher.drain(1000);
    expect(t.posted).toEqual([]);
    await feed(t, ["3"]);
    expect(t.posted).toHaveLength(1);
  });

  test("includes the run link only when an admin url is known", async () => {
    const withUrl = setup({ threshold: 1, adminUrl: "https://admin.example.com" });
    withUrl.automations.push(flaky);
    await feed(withUrl, ["1"]);
    const runId = withUrl.activity.queryRuns({ limit: 1 }).items[0]!.id;
    expect(withUrl.posted[0]!.text).toContain(`https://admin.example.com/runs/${runId}`);

    const without = setup({ threshold: 1 });
    without.automations.push(flaky);
    await feed(without, ["1"]);
    expect(without.posted[0]!.text).not.toContain("/runs/");
  });

  test("truncates a long error to 300 characters", async () => {
    const t = setup({ threshold: 1 });
    t.automations.push(inProject(defineAutomation({ name: "long", matches: (_e): _e is Event => true, run: async () => Promise.reject(new Error("x".repeat(2000))) })));
    t.dispatcher.enqueue(event("1"));
    await t.dispatcher.drain(1000);
    expect(t.posted[0]!.text.length).toBeLessThan(600);
  });

  test("silent when slack is not configured", async () => {
    const t = setup({ env: {} });
    t.automations.push(flaky);
    await feed(t, ["1", "2", "3"]);
    expect(t.posted).toEqual([]);
    expect(t.logged.filter((l) => l.includes("alert"))).toEqual([]);
  });

  test("bot only, no webhook: failures and token health alert nowhere and nothing throws", async () => {
    const t = setup({ env: { SLACK_BOT_TOKEN: "xoxb-1-2-secret", SLACK_SIGNING_SECRET: "signing" } });
    t.automations.push(flaky);
    await feed(t, ["1", "2", "3", "4"]);
    await t.notifyHealth(PROJECT, "github", undefined, { ok: false, message: "down", checkedAt: "2026-01-01T00:00:00Z" }, new Date());
    expect(t.posted).toEqual([]);
    expect(t.logged.filter((l) => l.includes("alert"))).toEqual([]);
  });

  test("a Slack failure does not throw, does not fail the run, and never logs the webhook url", async () => {
    const t = setup({ slackStatus: 500 });
    t.automations.push(flaky);
    await feed(t, ["1", "2", "3"]);
    expect(t.posted).toHaveLength(1);
    expect(t.logged.some((l) => l.includes("failure alert failed"))).toBe(true);
    expect(t.logged.join("\n")).not.toContain("SECRETSECRET");
    expect(t.activity.queryRuns({ limit: 10 }).items.every((r) => r.status === "failed")).toBe(true);
  });

  test("two failures finishing together post only once", async () => {
    const t = setup({ threshold: 2 });
    for (const id of ["1", "2"]) {
      const runId = t.activity.startRun({ project: PROJECT, automation: "flaky", source: "test", kind: "thing", externalId: id, startedAt: "2026-01-01T00:00:00Z" });
      t.activity.finishRun(runId, { status: "failed", error: "boom", finishedAt: "2026-01-01T00:00:01Z" });
    }
    const runs = t.activity.queryRuns({ limit: 10 }).items;
    await Promise.all(runs.map((r) => t.notify(r)));
    expect(t.posted).toHaveLength(1);
  });

  test("a failed post leaves no alerted mark, so a retry at the same streak posts", async () => {
    const t = setup({ threshold: 2 });
    const finish = (id: string) => {
      const runId = t.activity.startRun({ project: PROJECT, automation: "flaky", source: "test", kind: "thing", externalId: id, startedAt: "2026-01-01T00:00:00Z" });
      t.activity.finishRun(runId, { status: "failed", error: "boom", finishedAt: "2026-01-01T00:00:01Z" });
      return t.activity.queryRuns({ limit: 1 }).items[0]!;
    };
    finish("1");
    const second = finish("2");
    t.slack.status = 500;
    await t.notify(second);
    expect(t.posted).toHaveLength(1);
    t.slack.status = 200;
    await t.notify(second);
    expect(t.posted).toHaveLength(2);
    await t.notify(second);
    expect(t.posted).toHaveLength(2);
  });

  test("a success during the post clears the streak so the next streak alerts", async () => {
    const t = setup({ threshold: 2 });
    const failed = (id: string) => {
      const runId = t.activity.startRun({ project: PROJECT, automation: "flaky", source: "test", kind: "thing", externalId: id, startedAt: "2026-01-01T00:00:00Z" });
      t.activity.finishRun(runId, { status: "failed", error: "boom", finishedAt: "2026-01-01T00:00:01Z" });
      return t.activity.queryRuns({ limit: 1 }).items[0]!;
    };
    failed("1");
    const second = failed("2");
    const pending = t.notify(second);
    await t.notify({ ...second, status: "succeeded" });
    await pending;
    await t.notify(second);
    expect(t.posted).toHaveLength(2);
  });

  test("other projects do not share a streak", async () => {
    const t = setup({ threshold: 2 });
    for (const project of ["a", "b"]) {
      const runId = t.activity.startRun({ project, automation: "flaky", source: "test", kind: "thing", externalId: "1", startedAt: "2026-01-01T00:00:00Z" });
      t.activity.finishRun(runId, { status: "failed", error: "boom", finishedAt: "2026-01-01T00:00:01Z" });
    }
    for (const r of t.activity.queryRuns({ limit: 10 }).items) await t.notify(r);
    expect(t.posted).toEqual([]);
  });
});

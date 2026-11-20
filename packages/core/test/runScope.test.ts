import { describe, expect, test } from "bun:test";

import { defineAutomation } from "../src/automation";
import { createDispatcher } from "../src/dispatcher";
import type { Event } from "../src/event";
import { currentRun, type RunScope } from "../src/index";
import type { Logger } from "../src/logger";
import { createScheduler } from "../src/scheduler";
import { createSqliteActivityStore } from "../src/sqliteActivityStore";
import { createSqliteStore } from "../src/sqliteStore";

const quiet: Logger = { info() {}, warn() {}, error() {} };

const event = (externalId: string): Event => ({ project: "p1", source: "test", kind: "thing", externalId, receivedAt: "2026-01-01T00:00:00Z", payload: {} });

// Stands in for an LLM client built once at module build time: it takes no run argument.
const sharedClient = () => {
  const seen: { call: string; scope: RunScope | undefined }[] = [];
  return {
    seen,
    async call(name: string) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.push({ call: name, scope: currentRun() });
    },
  };
};

describe("run scope", () => {
  test("a call made inside an automation run is attributed to that run, across awaits and concurrent runs", async () => {
    const client = sharedClient();
    const activity = createSqliteActivityStore({ path: ":memory:" });
    const automation = {
      ...defineAutomation({
        name: "triage",
        matches: (e): e is Event => e.kind === "thing",
        async run(e) {
          await client.call(`${e.externalId}:first`);
          await client.call(`${e.externalId}:second`);
        },
      }),
      project: "p1",
    };
    const dispatcher = createDispatcher({ automations: () => [automation], store: createSqliteStore({ path: ":memory:" }), log: quiet, activity });
    dispatcher.enqueue(event("a"));
    dispatcher.enqueue(event("b"));
    await dispatcher.drain(1000);

    const runIdOf = (externalId: string) => activity.queryRuns({ limit: 10 }).items.find((r) => r.externalId === externalId)?.id ?? "missing";
    expect(client.seen).toHaveLength(4);
    for (const { call, scope } of client.seen) {
      expect(scope).toEqual({ runId: runIdOf(call.split(":")[0] ?? ""), project: "p1", automation: "triage", dryRun: false });
    }
    expect(currentRun()).toBeUndefined();
  });

  test("a dry run carries dryRun so its spend can be told apart", async () => {
    const client = sharedClient();
    const automation = { ...defineAutomation({ name: "triage", matches: (e): e is Event => e.kind === "thing", run: () => client.call("x") }), project: "p1", dryRun: true };
    const dispatcher = createDispatcher({ automations: () => [automation], store: createSqliteStore({ path: ":memory:" }), log: quiet });
    dispatcher.enqueue(event("a"));
    await dispatcher.drain(1000);
    expect(client.seen[0]?.scope).toEqual({ runId: null, project: "p1", automation: "triage", dryRun: true });
  });

  test("a scheduled job runs inside its own scope", async () => {
    const client = sharedClient();
    const activity = createSqliteActivityStore({ path: ":memory:" });
    const scheduler = createScheduler({
      jobs: () => [{ name: "outcome-sync", project: "p1", due: () => "2026-11-20T14", run: () => client.call("sync") }],
      store: createSqliteStore({ path: ":memory:" }),
      log: quiet,
      activity,
    });
    await scheduler.tick();
    const runId = activity.queryRuns({ limit: 1 }).items[0]?.id ?? "missing";
    expect(client.seen[0]?.scope).toEqual({ runId, project: "p1", automation: "outcome-sync", dryRun: false });
  });

  test("a call outside any run has no scope", async () => {
    const client = sharedClient();
    await client.call("probe");
    expect(client.seen[0]?.scope).toBeUndefined();
  });
});

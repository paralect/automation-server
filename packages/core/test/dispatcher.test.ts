import { describe, expect, test } from "bun:test";
import { defineAutomation, type Automation } from "../src/automation";
import { createDispatcher } from "../src/dispatcher";
import type { Event } from "../src/event";
import type { Logger } from "../src/logger";
import { createSqliteActivityStore } from "../src/sqliteActivityStore";
import { createSqliteStore } from "../src/sqliteStore";
import type { ActivityStore } from "../src/activity";

const event = (kind = "thing", externalId = "e1"): Event => ({
  source: "test",
  kind,
  externalId,
  receivedAt: "2026-01-01T00:00:00Z",
  payload: { secret: "SECRET-PAYLOAD" },
});

type Entry = { level: string; message: string; fields?: Record<string, unknown> };
const memoryLogger = () => {
  const entries: Entry[] = [];
  const at = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    entries.push({ level, message, fields });
  };
  const log: Logger = { info: at("info"), warn: at("warn"), error: at("error") };
  return { log, entries };
};

const setup = (automations: Automation[], prepare?: (event: Event) => Promise<Event>, activity?: ActivityStore) => {
  const { log, entries } = memoryLogger();
  const store = createSqliteStore({ path: ":memory:" });
  return { dispatcher: createDispatcher({ automations: () => automations, store, log, prepare, activity }), entries };
};

const auto = (name: string, run: Automation["run"], kind = "thing") =>
  defineAutomation({ name, matches: (e): e is Event => e.kind === kind, run });

describe("dispatcher", () => {
  test("runs matching automation and skips duplicate of a successful run", async () => {
    let runs = 0;
    const { dispatcher, entries } = setup([auto("a", async () => void runs++)]);
    dispatcher.enqueue(event());
    await dispatcher.drain(1000);
    dispatcher.enqueue(event());
    await dispatcher.drain(1000);
    expect(runs).toBe(1);
    expect(entries.some((e) => e.message === "duplicate skipped")).toBe(true);
  });

  test("failed run releases the claim so the same event can run again, without logging the payload", async () => {
    let runs = 0;
    const { dispatcher, entries } = setup([
      auto("a", async () => {
        runs++;
        if (runs === 1) throw new Error("boom");
      }),
    ]);
    dispatcher.enqueue(event());
    await dispatcher.drain(1000);
    dispatcher.enqueue(event());
    await dispatcher.drain(1000);
    expect(runs).toBe(2);
    const failure = entries.find((e) => e.level === "error");
    expect(failure?.fields?.error).toBe("boom");
    expect(JSON.stringify(entries)).not.toContain("SECRET-PAYLOAD");
  });

  test("one automation failing does not affect another", async () => {
    const ran: string[] = [];
    const { dispatcher } = setup([
      auto("bad", async () => {
        throw new Error("nope");
      }),
      auto("good", async () => void ran.push("good")),
    ]);
    dispatcher.enqueue(event());
    await dispatcher.drain(1000);
    expect(ran).toEqual(["good"]);
  });

  test("non-matching automation never runs and never claims", async () => {
    let runs = 0;
    const { dispatcher, entries } = setup([auto("other", async () => void runs++, "different")]);
    dispatcher.enqueue(event());
    await dispatcher.drain(1000);
    expect(runs).toBe(0);
    expect(entries).toEqual([]);
  });

  test("a throwing matches is logged and treated as no match", async () => {
    const ran: string[] = [];
    const throwing: Automation = {
      name: "throws",
      matches: () => {
        throw new Error("bad matcher");
      },
      run: async () => void ran.push("throws"),
    };
    const { dispatcher, entries } = setup([throwing, auto("ok", async () => void ran.push("ok"))]);
    dispatcher.enqueue(event());
    await dispatcher.drain(1000);
    expect(ran).toEqual(["ok"]);
    expect(entries.some((e) => e.level === "error" && e.fields?.error === "bad matcher")).toBe(true);
  });

  test("run receives a logger tagged with automation and externalId", async () => {
    const { dispatcher, entries } = setup([auto("tagged", async (_e, ctx) => ctx.log.info("hello"))]);
    dispatcher.enqueue(event("thing", "xyz"));
    await dispatcher.drain(1000);
    const hello = entries.find((e) => e.message === "hello");
    expect(hello?.fields).toMatchObject({ automation: "tagged", externalId: "xyz" });
  });

  test("drain waits for a slow run", async () => {
    let finished = false;
    const { dispatcher } = setup([
      auto("slow", async () => {
        await Bun.sleep(50);
        finished = true;
      }),
    ]);
    dispatcher.enqueue(event());
    expect(finished).toBe(false);
    await dispatcher.drain(2000);
    expect(finished).toBe(true);
  });

  test("drain resolves after the timeout even if work is still running", async () => {
    const { dispatcher } = setup([auto("stuck", () => new Promise<void>(() => {}))]);
    dispatcher.enqueue(event());
    const start = Date.now();
    await dispatcher.drain(30);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test("prepare runs inside tracked work and automations receive the prepared event", async () => {
    const seen: unknown[] = [];
    const { dispatcher } = setup([auto("a", async (e) => void seen.push(e.payload))], async (e) => {
      await new Promise((r) => setTimeout(r, 30));
      return { ...e, payload: "prepared" };
    });
    dispatcher.enqueue(event());
    expect(seen).toEqual([]);
    await dispatcher.drain(1000);
    expect(seen).toEqual(["prepared"]);
  });

  test("a failing prepare falls back to the original event and logs a warning without the payload", async () => {
    const seen: unknown[] = [];
    const { dispatcher, entries } = setup([auto("a", async (e) => void seen.push(e.externalId))], async () => {
      throw new Error("enrich down");
    });
    dispatcher.enqueue(event());
    await dispatcher.drain(1000);
    expect(seen).toEqual(["e1"]);
    const warn = entries.find((e) => e.level === "warn");
    expect(warn?.fields?.error).toBe("enrich down");
    expect(JSON.stringify(entries)).not.toContain("SECRET-PAYLOAD");
  });
});

describe("dispatcher activity recording", () => {
  const withActivity = (automations: Automation[]) => {
    const activity = createSqliteActivityStore({ path: ":memory:" });
    return { activity, ...setup(automations, undefined, activity) };
  };
  const runs = (activity: ActivityStore) => activity.queryRuns({ limit: 50 }).items;

  test("a successful run is recorded as succeeded with event identity", async () => {
    const { dispatcher, activity } = withActivity([auto("a", async () => {})]);
    dispatcher.enqueue(event("thing", "e9"));
    await dispatcher.drain(1000);
    expect(runs(activity)).toMatchObject([
      { automation: "a", source: "test", kind: "thing", externalId: "e9", status: "succeeded", error: null },
    ]);
    expect(runs(activity)[0]!.finishedAt).not.toBeNull();
  });

  test("a failed run is recorded with the error message", async () => {
    const { dispatcher, activity } = withActivity([
      auto("a", async () => {
        throw new Error("boom");
      }),
    ]);
    dispatcher.enqueue(event());
    await dispatcher.drain(1000);
    expect(runs(activity)).toMatchObject([{ status: "failed", error: "boom" }]);
  });

  test("a run is visible as running while the automation executes", async () => {
    let release!: () => void;
    const { dispatcher, activity } = withActivity([auto("a", () => new Promise<void>((r) => (release = r)))]);
    dispatcher.enqueue(event());
    await Bun.sleep(20);
    expect(runs(activity).map((r) => r.status)).toEqual(["running"]);
    release();
    await dispatcher.drain(1000);
    expect(runs(activity).map((r) => r.status)).toEqual(["succeeded"]);
  });

  test("a duplicate claim is recorded as a duplicate run alongside the succeeded one", async () => {
    const { dispatcher, activity } = withActivity([auto("a", async () => {})]);
    dispatcher.enqueue(event());
    await dispatcher.drain(1000);
    dispatcher.enqueue(event());
    await dispatcher.drain(1000);
    expect(runs(activity).map((r) => r.status)).toEqual(["duplicate", "succeeded"]);
  });

  test("every automation log line carries the runId of its run", async () => {
    const { dispatcher, activity, entries } = withActivity([
      auto("a", async (_e, ctx) => {
        ctx.log.info("working");
        throw new Error("late failure");
      }),
    ]);
    dispatcher.enqueue(event());
    await dispatcher.drain(1000);
    const [run] = runs(activity);
    for (const message of ["working", "automation failed"]) {
      expect(entries.find((e) => e.message === message)?.fields?.runId).toBe(run!.id);
    }
  });

  test("an activity store that throws never breaks dispatching", async () => {
    const broken = new Proxy({} as ActivityStore, {
      get: () => () => {
        throw new Error("disk full");
      },
    });
    let ran = 0;
    const { dispatcher, entries } = setup([auto("a", async () => void ran++)], undefined, broken);
    dispatcher.enqueue(event());
    await dispatcher.drain(1000);
    dispatcher.enqueue(event());
    await dispatcher.drain(1000);
    expect(ran).toBe(1);
    expect(entries.some((e) => e.level === "error" && e.fields?.error === "disk full")).toBe(true);
  });
});

describe("dispatcher projects", () => {
  test("an event reaches only the automations of its project, and claims are per project", async () => {
    const ran: string[] = [];
    const scoped = (project: string): Automation => ({ ...auto("a", async () => void ran.push(project)), project });
    const activity = createSqliteActivityStore({ path: ":memory:" });
    const { dispatcher } = setup([scoped("acme"), scoped("globex")], undefined, activity);
    dispatcher.enqueue({ ...event(), project: "acme" });
    await dispatcher.drain(1000);
    dispatcher.enqueue({ ...event(), project: "globex" });
    await dispatcher.drain(1000);
    dispatcher.enqueue(event());
    await dispatcher.drain(1000);
    expect(ran).toEqual(["acme", "globex"]);
    expect(activity.queryRuns({ project: "acme", limit: 10 }).items.map((r) => r.status)).toEqual(["succeeded"]);
    expect(activity.queryRuns({ project: "globex", limit: 10 }).items.map((r) => r.project)).toEqual(["globex"]);
  });
});

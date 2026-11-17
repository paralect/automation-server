import { describe, expect, test } from "bun:test";
import { defineAutomation, withDryRun, type Automation } from "../src/automation";
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

  test("the outcome an automation reports is kept on its run, also when the run then fails", async () => {
    const activity = createSqliteActivityStore({ path: ":memory:" });
    const { dispatcher } = setup(
      [
        auto("ok", async (_e, { report }) => report?.({ decision: "issue", n: 1 }), "good"),
        auto(
          "bad",
          async (_e, { report }) => {
            report?.({ decision: "fix" });
            report?.({ decision: "fix", replaced: true });
            throw new Error("boom");
          },
          "broken",
        ),
      ],
      undefined,
      activity,
    );
    dispatcher.enqueue(event("good", "g1"));
    dispatcher.enqueue(event("broken", "b1"));
    await dispatcher.drain(1000);
    const runs = activity.queryRuns({ limit: 10 }).items;
    expect(runs.find((r) => r.automation === "ok")?.outcome).toEqual({ decision: "issue", n: 1 });
    const failed = runs.find((r) => r.automation === "bad");
    expect(failed).toMatchObject({ status: "failed", outcome: { decision: "fix", replaced: true } });
    activity.close();
  });
});

describe("dispatcher failures outside the automation", () => {
  const unhandled = () => {
    const seen: unknown[] = [];
    const listener = (reason: unknown) => void seen.push(reason);
    process.on("unhandledRejection", listener);
    return {
      seen,
      async stop() {
        await Bun.sleep(10);
        process.off("unhandledRejection", listener);
      },
    };
  };

  test("a claim store that fails to complete keeps a successful run succeeded and its claim held", async () => {
    const { log, entries } = memoryLogger();
    const activity = createSqliteActivityStore({ path: ":memory:" });
    const store = { ...createSqliteStore({ path: ":memory:" }), complete: () => {
      throw new Error("disk full");
    } };
    let runs = 0;
    const dispatcher = createDispatcher({ automations: () => [auto("a", async () => void runs++)], store, log, activity });
    dispatcher.enqueue(event());
    await dispatcher.drain(1000);
    dispatcher.enqueue(event());
    await dispatcher.drain(1000);
    expect(runs).toBe(1);
    expect(activity.queryRuns({ limit: 10 }).items.map((r) => r.status)).toEqual(["duplicate", "succeeded"]);
    expect(entries.some((e) => e.level === "error" && e.fields?.error === "disk full")).toBe(true);
    expect(entries.some((e) => e.message === "automation failed")).toBe(false);
  });

  test("an automation list that throws is logged and never becomes an unhandled rejection", async () => {
    const rejections = unhandled();
    const { log, entries } = memoryLogger();
    const dispatcher = createDispatcher({
      automations: () => {
        throw new Error("registry broken");
      },
      store: createSqliteStore({ path: ":memory:" }),
      log,
    });
    dispatcher.enqueue(event());
    await dispatcher.drain(1000);
    await rejections.stop();
    expect(rejections.seen).toEqual([]);
    expect(entries.some((e) => e.level === "error" && e.fields?.error === "registry broken")).toBe(true);
  });
});

describe("dispatcher replay", () => {
  const scoped = (name: string, run: Automation["run"], project = "acme", kind = "thing"): Automation => ({
    ...auto(name, run, kind),
    project,
  });
  const withActivity = (automations: Automation[], prepare?: (event: Event) => Promise<Event>) => {
    const activity = createSqliteActivityStore({ path: ":memory:" });
    return { activity, ...setup(automations, prepare, activity) };
  };
  const request = (over: Partial<Parameters<ReturnType<typeof setup>["dispatcher"]["replay"]>[0]> = {}) => ({
    project: "acme",
    automation: "a",
    event: event(),
    replayOf: "run-1",
    ...over,
  });

  test("runs exactly the named automation, even when another one would also match, and links the original run", async () => {
    const ran: string[] = [];
    const { dispatcher, activity } = withActivity([scoped("a", async () => void ran.push("a")), scoped("b", async () => void ran.push("b"))]);
    const result = await dispatcher.replay(request());
    await dispatcher.drain(1000);
    expect(result.outcome).toBe("started");
    expect(ran).toEqual(["a"]);
    const stored = activity.getRun(result.runId!);
    expect(stored?.run).toMatchObject({ automation: "a", project: "acme", status: "succeeded", replayOf: "run-1", hasEvent: true });
    expect(stored?.event?.payload).toEqual({ secret: "[redacted]" });
  });

  test("bypasses matches", async () => {
    let ran = 0;
    const { dispatcher } = withActivity([scoped("a", async () => void ran++, "acme", "other-kind")]);
    const result = await dispatcher.replay(request());
    await dispatcher.drain(1000);
    expect(result.outcome).toBe("started");
    expect(ran).toBe(1);
  });

  test("re-runs prepare and hands the prepared event to the automation while storing the original", async () => {
    const seen: unknown[] = [];
    const { dispatcher, activity } = withActivity([scoped("a", async (e) => void seen.push(e.payload))], async (e) => ({ ...e, payload: "enriched" }));
    const result = await dispatcher.replay(request());
    await dispatcher.drain(1000);
    expect(seen).toEqual(["enriched"]);
    expect(activity.getRun(result.runId!)?.event?.payload).toEqual({ secret: "[redacted]" });
  });

  test("returns the run id while the automation is still running", async () => {
    let release!: () => void;
    const { dispatcher, activity } = withActivity([scoped("a", () => new Promise<void>((r) => (release = r)))]);
    const result = await dispatcher.replay(request());
    expect(activity.getRun(result.runId!)?.run.status).toBe("running");
    release();
    await dispatcher.drain(1000);
    expect(activity.getRun(result.runId!)?.run.status).toBe("succeeded");
  });

  test("a failed run releases its claim so a replay then succeeds", async () => {
    let calls = 0;
    const { dispatcher, activity } = withActivity([
      scoped("a", async () => {
        if (++calls === 1) throw new Error("boom");
      }),
    ]);
    dispatcher.enqueue({ ...event(), project: "acme" });
    await dispatcher.drain(1000);
    const failed = activity.queryRuns({ limit: 10 }).items[0]!;
    expect(failed.status).toBe("failed");
    const result = await dispatcher.replay(request({ replayOf: failed.id }));
    await dispatcher.drain(1000);
    expect(result.outcome).toBe("started");
    expect(activity.getRun(result.runId!)?.run).toMatchObject({ status: "succeeded", replayOf: failed.id });
  });

  test("a replay of an event whose claim is already done is a duplicate", async () => {
    const { dispatcher } = withActivity([scoped("a", async () => {})]);
    await dispatcher.replay(request());
    await dispatcher.drain(1000);
    const again = await dispatcher.replay(request());
    expect(again.outcome).toBe("duplicate");
  });

  test("a dry run hands ctx.dryRun to the automation, marks the row, and leaves the claim state alone", async () => {
    const seen: (boolean | undefined)[] = [];
    const { dispatcher, activity } = withActivity([scoped("a", async (_e, ctx) => void seen.push(ctx.dryRun))]);
    await dispatcher.replay(request());
    await dispatcher.drain(1000);
    const dry = await dispatcher.replay(request({ dryRun: true }));
    await dispatcher.drain(1000);
    expect(dry.outcome).toBe("started");
    expect(seen).toEqual([undefined, true]);
    expect(activity.getRun(dry.runId!)?.run).toMatchObject({ status: "succeeded", dryRun: true });
    expect((await dispatcher.replay(request())).outcome).toBe("duplicate");
  });

  test("a failed dry run does not release the claim of a real run still in flight", async () => {
    let release!: () => void;
    const { dispatcher, activity } = withActivity([
      scoped("a", (_e, ctx) => {
        if (ctx.dryRun) throw new Error("dry boom");
        return new Promise<void>((r) => (release = r));
      }),
    ]);
    const real = await dispatcher.replay(request());
    const dry = await dispatcher.replay(request({ dryRun: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(activity.getRun(dry.runId!)?.run).toMatchObject({ status: "failed", dryRun: true });
    expect((await dispatcher.replay(request())).outcome).toBe("duplicate");
    release();
    await dispatcher.drain(1000);
    expect(activity.getRun(real.runId!)?.run.status).toBe("succeeded");
  });

  test("an unknown automation or a different project returns unknown-automation without running anything", async () => {
    let ran = 0;
    const { dispatcher } = withActivity([scoped("a", async () => void ran++)]);
    expect(await dispatcher.replay(request({ automation: "gone" }))).toEqual({ outcome: "unknown-automation" });
    expect(await dispatcher.replay(request({ project: "other" }))).toEqual({ outcome: "unknown-automation" });
    expect(ran).toBe(0);
  });
});

describe("withDryRun", () => {
  test("every run of a wrapped automation is a dry run, live events included", async () => {
    const seen: (boolean | undefined)[] = [];
    const activity = createSqliteActivityStore({ path: ":memory:" });
    const wrapped = withDryRun({ ...auto("a", async (_e, ctx) => void seen.push(ctx.dryRun)), project: "acme" });
    const { dispatcher } = setup([wrapped], undefined, activity);
    dispatcher.enqueue({ ...event(), project: "acme" });
    await dispatcher.drain(1000);
    expect(seen).toEqual([true]);
    expect(activity.queryRuns({ limit: 10 }).items[0]).toMatchObject({ status: "succeeded", dryRun: true });
  });
});

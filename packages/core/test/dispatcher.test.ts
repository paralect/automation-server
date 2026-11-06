import { describe, expect, test } from "bun:test";
import { defineAutomation, type Automation } from "../src/automation";
import { createDispatcher } from "../src/dispatcher";
import type { Event } from "../src/event";
import type { Logger } from "../src/logger";
import { createSqliteStore } from "../src/sqliteStore";

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

const setup = (automations: Automation[]) => {
  const { log, entries } = memoryLogger();
  const store = createSqliteStore({ path: ":memory:" });
  return { dispatcher: createDispatcher({ automations, store, log }), entries };
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
});

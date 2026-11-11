import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { ActivityStore, LogEntry, RunStart } from "../src/activity";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSqliteActivityStore } from "../src/sqliteActivityStore";

const open: ActivityStore[] = [];
const make = (now?: () => number) => {
  const s = createSqliteActivityStore({ path: ":memory:", now });
  open.push(s);
  return s;
};
afterEach(() => {
  while (open.length) open.pop()!.close();
});

const entry = (message: string, fields: Record<string, unknown> = {}, level: LogEntry["level"] = "info", time = "2026-01-01T00:00:00.000Z"): LogEntry => ({
  time,
  level,
  message,
  fields,
});
const runStart = (over: Partial<RunStart> = {}): RunStart => ({
  automation: "a",
  source: "sentry",
  kind: "alert",
  externalId: "e1",
  startedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("logs", () => {
  test("lifts known fields and keeps the full fields", () => {
    const s = make();
    s.recordLog(entry("hi", { source: "sentry", automation: "a", externalId: "e1", runId: "r1", extra: 5 }));
    const [log] = s.queryLogs({ limit: 10 }).items;
    expect(log).toMatchObject({ message: "hi", level: "info", source: "sentry", automation: "a", externalId: "e1", runId: "r1" });
    expect(log!.fields).toEqual({ source: "sentry", automation: "a", externalId: "e1", runId: "r1", extra: 5 });
  });

  test("non-string lifted fields become null", () => {
    const s = make();
    s.recordLog(entry("hi", { source: 5 }));
    expect(s.queryLogs({ limit: 10 }).items[0]!.source).toBeNull();
  });

  test("filters by level, source, automation and runId", () => {
    const s = make();
    s.recordLog(entry("one", { source: "sentry", automation: "a", runId: "r1" }));
    s.recordLog(entry("two", { source: "github", automation: "b" }, "error"));
    s.recordLog(entry("three", { source: "sentry", automation: "b", runId: "r2" }, "warn"));
    const msgs = (q: Parameters<ActivityStore["queryLogs"]>[0]) => s.queryLogs(q).items.map((l) => l.message);
    expect(msgs({ limit: 10, level: "error" })).toEqual(["two"]);
    expect(msgs({ limit: 10, source: "sentry" })).toEqual(["three", "one"]);
    expect(msgs({ limit: 10, automation: "b" })).toEqual(["three", "two"]);
    expect(msgs({ limit: 10, runId: "r2" })).toEqual(["three"]);
    expect(msgs({ limit: 10, source: "sentry", automation: "b" })).toEqual(["three"]);
  });

  test("pages newest first with a cursor and ends with null", () => {
    const s = make();
    for (let i = 1; i <= 5; i++) s.recordLog(entry(`m${i}`));
    const p1 = s.queryLogs({ limit: 2 });
    expect(p1.items.map((l) => l.message)).toEqual(["m5", "m4"]);
    expect(p1.nextCursor).toBe(p1.items[1]!.id);
    const p2 = s.queryLogs({ limit: 2, before: p1.nextCursor! });
    expect(p2.items.map((l) => l.message)).toEqual(["m3", "m2"]);
    const p3 = s.queryLogs({ limit: 2, before: p2.nextCursor! });
    expect(p3.items.map((l) => l.message)).toEqual(["m1"]);
    expect(p3.nextCursor).toBeNull();
  });

  test("an exact-size last page has no next cursor", () => {
    const s = make();
    s.recordLog(entry("a"));
    s.recordLog(entry("b"));
    expect(s.queryLogs({ limit: 2 }).nextCursor).toBeNull();
  });

  test("search matches message, externalId and automation and treats % and _ literally", () => {
    const s = make();
    s.recordLog(entry("100% done", { externalId: "x" }));
    s.recordLog(entry("under_score", { externalId: "y" }));
    s.recordLog(entry("plain", { externalId: "needle-9", automation: "other" }));
    s.recordLog(entry("fullstop", { automation: "sentryToGithubIssue" }));
    const found = (search: string) => s.queryLogs({ limit: 10, search }).items.map((l) => l.message);
    expect(found("100%")).toEqual(["100% done"]);
    expect(found("%")).toEqual(["100% done"]);
    expect(found("_")).toEqual(["under_score"]);
    expect(found("needle")).toEqual(["plain"]);
    expect(found("ToGithub")).toEqual(["fullstop"]);
    expect(found("'; DROP TABLE logs; --")).toEqual([]);
    expect(s.queryLogs({ limit: 10 }).items).toHaveLength(4);
  });
});

describe("runs", () => {
  test("start then finish records status, error and finish time", () => {
    const s = make();
    const ok = s.startRun(runStart({ externalId: "ok" }));
    const bad = s.startRun(runStart({ externalId: "bad" }));
    expect(s.queryRuns({ limit: 10, status: "running" }).items).toHaveLength(2);
    s.finishRun(ok, { status: "succeeded", finishedAt: "2026-01-01T00:00:05.000Z" });
    s.finishRun(bad, { status: "failed", error: "boom", finishedAt: "2026-01-01T00:00:06.000Z" });
    expect(s.getRun(ok)!.run).toMatchObject({ status: "succeeded", finishedAt: "2026-01-01T00:00:05.000Z", error: null });
    expect(s.getRun(bad)!.run).toMatchObject({ status: "failed", error: "boom", externalId: "bad" });
  });

  test("duplicates are stored as finished duplicate runs", () => {
    const s = make();
    const id = s.recordDuplicate(runStart());
    expect(s.getRun(id)!.run).toMatchObject({ status: "duplicate", finishedAt: "2026-01-01T00:00:00.000Z" });
  });

  test("filters, search and cursor paging", () => {
    const s = make();
    s.recordDuplicate(runStart({ automation: "a", externalId: "e1" }));
    s.recordDuplicate(runStart({ automation: "b", source: "github", externalId: "needle" }));
    const failing = s.startRun(runStart({ automation: "a", externalId: "e3" }));
    s.finishRun(failing, { status: "failed", error: "rate_limited", finishedAt: "2026-01-01T00:00:01.000Z" });
    const ids = (q: Parameters<ActivityStore["queryRuns"]>[0]) => s.queryRuns(q).items.map((r) => r.externalId);
    expect(ids({ limit: 10 })).toEqual(["e3", "needle", "e1"]);
    expect(ids({ limit: 10, status: "duplicate" })).toEqual(["needle", "e1"]);
    expect(ids({ limit: 10, automation: "a" })).toEqual(["e3", "e1"]);
    expect(ids({ limit: 10, source: "github" })).toEqual(["needle"]);
    expect(ids({ limit: 10, search: "need" })).toEqual(["needle"]);
    expect(ids({ limit: 10, search: "rate_" })).toEqual(["e3"]);
    expect(ids({ limit: 10, search: "rate%" })).toEqual([]);
    const p1 = s.queryRuns({ limit: 2 });
    expect(p1.nextCursor).toBe(p1.items[1]!.seq);
    const p2 = s.queryRuns({ limit: 2, before: p1.nextCursor! });
    expect(p2.items.map((r) => r.externalId)).toEqual(["e1"]);
    expect(p2.nextCursor).toBeNull();
  });

  test("getRun returns its logs oldest first and null for an unknown id", () => {
    const s = make();
    const id = s.startRun(runStart());
    s.recordLog(entry("first", { runId: id }));
    s.recordLog(entry("elsewhere", { runId: "other" }));
    s.recordLog(entry("second", { runId: id }));
    expect(s.getRun(id)!.logs.map((l) => l.message)).toEqual(["first", "second"]);
    expect(s.getRun("missing")).toBeNull();
  });

  test("failInterruptedRuns fails only running runs", () => {
    const s = make();
    const running = s.startRun(runStart());
    const done = s.startRun(runStart({ externalId: "e2" }));
    s.finishRun(done, { status: "succeeded", finishedAt: "2026-01-01T00:00:01.000Z" });
    expect(s.failInterruptedRuns("2026-01-02T00:00:00.000Z")).toBe(1);
    expect(s.getRun(running)!.run).toMatchObject({
      status: "failed",
      error: "interrupted by server restart",
      finishedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(s.getRun(done)!.run.status).toBe("succeeded");
  });

  test("a finished run is not changed by a later finish", () => {
    const s = make();
    const id = s.startRun(runStart());
    s.finishRun(id, { status: "succeeded", finishedAt: "2026-01-01T00:00:01.000Z" });
    s.finishRun(id, { status: "failed", error: "late", finishedAt: "2026-01-01T00:00:02.000Z" });
    expect(s.getRun(id)!.run.status).toBe("succeeded");
  });
});

describe("prune", () => {
  test("deletes old logs and finished runs but keeps recent ones and running ones", () => {
    const s = make();
    s.recordLog(entry("old", {}, "info", "2025-12-01T00:00:00.000Z"));
    s.recordLog(entry("new", {}, "info", "2026-01-10T00:00:00.000Z"));
    const oldDone = s.startRun(runStart({ externalId: "old", startedAt: "2025-12-01T00:00:00.000Z" }));
    s.finishRun(oldDone, { status: "succeeded", finishedAt: "2025-12-01T00:00:01.000Z" });
    s.startRun(runStart({ externalId: "stuck", startedAt: "2025-12-01T00:00:00.000Z" }));
    s.recordDuplicate(runStart({ externalId: "new", startedAt: "2026-01-10T00:00:00.000Z" }));
    expect(s.prune("2026-01-01T00:00:00.000Z")).toBe(2);
    expect(s.queryLogs({ limit: 10 }).items.map((l) => l.message)).toEqual(["new"]);
    expect(s.queryRuns({ limit: 10 }).items.map((r) => r.externalId)).toEqual(["new", "stuck"]);
  });
});

describe("stats", () => {
  const HOUR = 3_600_000;
  const at = (iso: string) => Date.parse(iso);

  test("counts runs and logs since the cutoff", () => {
    const s = make(() => at("2026-01-01T10:30:00.000Z"));
    s.recordDuplicate(runStart({ startedAt: "2026-01-01T08:10:00.000Z" }));
    const ok = s.startRun(runStart({ startedAt: "2026-01-01T09:10:00.000Z" }));
    s.finishRun(ok, { status: "succeeded", finishedAt: "2026-01-01T09:10:01.000Z" });
    s.startRun(runStart({ startedAt: "2026-01-01T10:10:00.000Z" }));
    s.startRun(runStart({ startedAt: "2025-12-01T10:10:00.000Z" }));
    s.recordLog(entry("old", {}, "error", "2025-12-01T00:00:00.000Z"));
    s.recordLog(entry("w", {}, "warn", "2026-01-01T09:00:00.000Z"));
    s.recordLog(entry("e", {}, "error", "2026-01-01T09:30:00.000Z"));
    const stats = s.stats("2026-01-01T08:00:00.000Z", HOUR);
    expect(stats.runs).toEqual({ running: 1, succeeded: 1, failed: 0, duplicate: 1 });
    expect(stats.logs).toEqual({ info: 0, warn: 1, error: 1 });
  });

  test("buckets are continuous, aligned to the bucket size and include empty ones", () => {
    const s = make(() => at("2026-01-01T11:30:00.000Z"));
    const f = s.startRun(runStart({ startedAt: "2026-01-01T08:59:59.000Z" }));
    s.finishRun(f, { status: "failed", error: "x", finishedAt: "2026-01-01T09:00:00.000Z" });
    s.recordDuplicate(runStart({ startedAt: "2026-01-01T09:15:00.000Z" }));
    s.recordDuplicate(runStart({ startedAt: "2026-01-01T09:45:00.000Z" }));
    const ok = s.startRun(runStart({ startedAt: "2026-01-01T11:05:00.000Z" }));
    s.finishRun(ok, { status: "succeeded", finishedAt: "2026-01-01T11:05:01.000Z" });
    const { buckets } = s.stats("2026-01-01T08:00:00.000Z", HOUR);
    expect(buckets.map((b) => b.start)).toEqual([
      "2026-01-01T08:00:00.000Z",
      "2026-01-01T09:00:00.000Z",
      "2026-01-01T10:00:00.000Z",
      "2026-01-01T11:00:00.000Z",
    ]);
    expect(buckets.map(({ succeeded, failed, duplicate }) => [succeeded, failed, duplicate])).toEqual([
      [0, 1, 0],
      [0, 0, 2],
      [0, 0, 0],
      [1, 0, 0],
    ]);
  });

  test("recentFailures lists the five most recent failed runs, newest first", () => {
    const s = make();
    for (let i = 1; i <= 7; i++) {
      const id = s.startRun(runStart({ externalId: `f${i}` }));
      s.finishRun(id, { status: "failed", error: `err${i}`, finishedAt: "2026-01-01T00:00:01.000Z" });
    }
    const ok = s.startRun(runStart({ externalId: "fine" }));
    s.finishRun(ok, { status: "succeeded", finishedAt: "2026-01-01T00:00:01.000Z" });
    const { recentFailures } = s.stats("2025-01-01T00:00:00.000Z", HOUR * 24 * 365);
    expect(recentFailures.map((r) => r.externalId)).toEqual(["f7", "f6", "f5", "f4", "f3"]);
    expect(recentFailures[0]!.error).toBe("err7");
  });
});

describe("projects", () => {
  test("runs are filtered by project and logs include server-wide lines", () => {
    const s = make();
    s.startRun(runStart({ project: "acme" }));
    s.startRun(runStart({ project: "globex" }));
    s.recordLog(entry("acme line", { project: "acme" }));
    s.recordLog(entry("globex line", { project: "globex" }));
    s.recordLog(entry("server started"));
    expect(s.queryRuns({ project: "acme", limit: 10 }).items.map((r) => r.project)).toEqual(["acme"]);
    expect(s.queryLogs({ project: "acme", limit: 10 }).items.map((l) => l.message)).toEqual(["server started", "acme line"]);
    expect(s.queryLogs({ limit: 10 }).items).toHaveLength(3);
    expect(s.stats("2025-12-31T00:00:00.000Z", 3_600_000, "globex").runs.running).toBe(1);
    expect(s.stats("2025-12-31T00:00:00.000Z", 3_600_000, "globex").logs.info).toBe(2);
  });

  test("rows recorded before projects existed get the legacy project when the column is added", () => {
    const dir = mkdtempSync(join(tmpdir(), "activity-"));
    const path = join(dir, "db.sqlite");
    const legacy = new Database(path);
    legacy.run("CREATE TABLE runs (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, automation TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, external_id TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, error TEXT)");
    legacy.run("INSERT INTO runs (id, automation, source, kind, external_id, status, started_at) VALUES ('r1', 'a', 's', 'k', 'e', 'succeeded', '2026-01-01T00:00:00.000Z')");
    legacy.close();
    try {
      const s = createSqliteActivityStore({ path, legacyProject: "default" });
      s.startRun(runStart());
      s.close();
      const again = createSqliteActivityStore({ path, legacyProject: "default" });
      expect(again.queryRuns({ limit: 10 }).items.map((r) => r.project)).toEqual([null, "default"]);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

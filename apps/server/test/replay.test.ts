import { canReplay } from "@automation-server/api/replay";
import { describe, expect, test } from "bun:test";

type Run = Parameters<typeof canReplay>[0];
const run = (over: Partial<Run> = {}): Run => ({ status: "failed", source: "sentry", hasEvent: true, dryRun: false, ...over });

describe("canReplay", () => {
  test("a failed run with a stored event is replayable", () => {
    expect(canReplay(run())).toEqual({ ok: true });
  });

  test("running, succeeded and duplicate runs are not, each with its own reason", () => {
    const reasons = (["running", "succeeded", "duplicate"] as const).map((status) => canReplay(run({ status })));
    for (const r of reasons) expect(r.ok).toBe(false);
    expect(new Set(reasons.map((r) => (r.ok ? "" : r.reason))).size).toBe(3);
  });

  test("a failed run without an event is refused", () => {
    expect(canReplay(run({ hasEvent: false }))).toEqual({ ok: false, reason: "This run has no stored event" });
  });

  test("a failed scheduled run needs no event", () => {
    expect(canReplay(run({ source: "schedule", hasEvent: false }))).toEqual({ ok: true });
  });

  test("a succeeded scheduled run is still refused", () => {
    expect(canReplay(run({ source: "schedule", status: "succeeded", hasEvent: false })).ok).toBe(false);
  });

  test("a dry-run row is never replayable for real, even when failed", () => {
    const result = canReplay(run({ dryRun: true }));
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("dry run") });
    expect(canReplay(run({ dryRun: true, source: "schedule", hasEvent: false })).ok).toBe(false);
  });

  describe("dry run", () => {
    const dry = (over: Partial<Run> = {}) => canReplay(run(over), { dryRun: true });

    test("is allowed for failed and succeeded runs with a stored event", () => {
      expect(dry()).toEqual({ ok: true });
      expect(dry({ status: "succeeded" })).toEqual({ ok: true });
    });

    test("is never allowed for running or duplicate runs", () => {
      expect(dry({ status: "running" }).ok).toBe(false);
      expect(dry({ status: "duplicate" }).ok).toBe(false);
    });

    test("is refused for scheduled jobs, saying so, and for runs without an event", () => {
      expect(dry({ source: "schedule", hasEvent: false })).toEqual({ ok: false, reason: expect.stringContaining("Scheduled jobs cannot be dry-run") });
      expect(dry({ hasEvent: false })).toEqual({ ok: false, reason: "This run has no stored event" });
    });

    test("stays allowed for a dry-run row that has an event", () => {
      expect(dry({ dryRun: true })).toEqual({ ok: true });
      expect(dry({ dryRun: true, status: "succeeded" })).toEqual({ ok: true });
      expect(dry({ dryRun: true, hasEvent: false }).ok).toBe(false);
    });

    test("leaves the real replay rules as they were", () => {
      expect(canReplay(run({ status: "succeeded" }), { dryRun: false }).ok).toBe(false);
      expect(canReplay(run({ status: "succeeded" })).ok).toBe(false);
    });
  });
});

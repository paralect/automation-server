import { canReplay } from "@automation-server/api/replay";
import { describe, expect, test } from "bun:test";

type Run = Parameters<typeof canReplay>[0];
const run = (over: Partial<Run> = {}): Run => ({ status: "failed", source: "sentry", hasEvent: true, ...over });

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
});

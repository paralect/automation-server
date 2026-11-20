import { describe, expect, test } from "bun:test";

import { monthBounds, monthOf, projectedSpend, reachedThresholds } from "../src/budget";
import { microUsd, toMicroUsd } from "../src/facts";
import { median, outcomeCounts, weeklyBuckets, windowOf } from "../src/metrics";
import type { PullRequestLifecycle, PullRequestRecord } from "../src/types";
import { APP } from "./fixtures";

const REPO = APP;
const NOW = new Date("2026-11-20T12:00:00.000Z");
const ago = (days: number, hours = 0) => new Date(NOW.getTime() - days * 86_400_000 - hours * 3_600_000).toISOString();

let next = 1;
const pr = (createdAt: string, lifecycle: PullRequestLifecycle): PullRequestRecord => ({
  repo: REPO,
  number: next++,
  producer: "codex-issue-fix",
  workKey: null,
  title: "t",
  url: "u",
  createdAt,
  lifecycle,
});

describe("median", () => {
  test("odd, even, empty", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("outcome counts", () => {
  test("useful rate is merged over resolved in the window; open PRs never enter it", () => {
    const counts = outcomeCounts(
      [
        pr(ago(10), { state: "merged", mergedAt: ago(9) }),
        pr(ago(8), { state: "merged", mergedAt: ago(7) }),
        pr(ago(6), { state: "merged", mergedAt: ago(5) }),
        pr(ago(4), { state: "closed", closedAt: ago(3) }),
        pr(ago(2), { state: "open", draft: true }),
        pr(ago(1), { state: "open", draft: false }),
      ],
      windowOf(30, NOW),
    );
    expect(counts).toEqual({ opened: 6, merged: 3, closed: 1, open: 2, usefulRate: 0.75, medianHoursToMerge: 24 });
  });

  test("window edges: an event exactly on the edge counts, one millisecond before does not; a PR opened before the window still counts as merged in it", () => {
    const window = windowOf(30, NOW);
    const edge = ago(30);
    const before = new Date(Date.parse(edge) - 1).toISOString();
    const counts = outcomeCounts(
      [
        pr(edge, { state: "merged", mergedAt: edge }),
        pr(before, { state: "closed", closedAt: before }),
        pr(ago(60), { state: "merged", mergedAt: ago(1) }),
      ],
      window,
    );
    expect(counts.opened).toBe(1);
    expect(counts.merged).toBe(2);
    expect(counts.closed).toBe(0);
    expect(counts.usefulRate).toBe(1);
    expect(counts.medianHoursToMerge).toBe((0 + 59 * 24) / 2);
  });

  test("nothing resolved means no rate and no median, not zero", () => {
    expect(outcomeCounts([pr(ago(1), { state: "open", draft: true })], windowOf(30, NOW))).toEqual({
      opened: 1,
      merged: 0,
      closed: 0,
      open: 1,
      usefulRate: null,
      medianHoursToMerge: null,
    });
  });

  test("weekly buckets start on Monday UTC, cover the window oldest first, and count each event in its own week", () => {
    const weeks = weeklyBuckets([pr(ago(10), { state: "merged", mergedAt: ago(1) }), pr(ago(40), { state: "closed", closedAt: ago(2) })], windowOf(30, NOW));
    expect(weeks[0]?.start).toBe("2026-10-19T00:00:00.000Z");
    expect(weeks.at(-1)?.start).toBe("2026-11-16T00:00:00.000Z");
    expect(weeks).toHaveLength(5);
    expect(weeks.reduce((n, w) => n + w.opened, 0)).toBe(1);
    expect(weeks.find((w) => w.start === "2026-11-09T00:00:00.000Z")?.opened).toBe(1);
    expect(weeks.at(-1)).toMatchObject({ merged: 1, closed: 1 });
  });
});

describe("budget math", () => {
  test("dollars become integer micro-dollars at the boundary", () => {
    expect(toMicroUsd(0.0132)).toBe(microUsd(13_200));
    expect(toMicroUsd(1e-7)).toBe(microUsd(0));
    expect(() => toMicroUsd(-1)).toThrow();
    expect(() => toMicroUsd(Number.NaN)).toThrow();
  });

  test("thresholds are reached at exactly 80% and 100%", () => {
    const budget = toMicroUsd(50);
    expect(reachedThresholds(toMicroUsd(39.99), budget)).toEqual([]);
    expect(reachedThresholds(toMicroUsd(40), budget)).toEqual([80]);
    expect(reachedThresholds(toMicroUsd(50), budget)).toEqual([80, 100]);
    expect(reachedThresholds(toMicroUsd(10), microUsd(0))).toEqual([]);
  });

  test("months are UTC and the projection scales spend by days elapsed", () => {
    expect(monthOf(new Date("2026-11-30T23:59:59Z"))).toBe("2026-11");
    expect(monthOf(new Date("2026-12-01T00:00:00Z"))).toBe("2026-12");
    expect(monthBounds("2026-12").end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(projectedSpend(toMicroUsd(20), "2026-11", NOW)).toBe(toMicroUsd(30));
    expect(projectedSpend(toMicroUsd(20), "2026-10", NOW)).toBeNull();
    expect(projectedSpend(microUsd(0), "2026-11", NOW)).toBeNull();
  });
});

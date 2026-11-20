import type { OutcomeCounts, OutcomeSummary, PullRequestRecord } from "./types";

export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * DAY_MS;

// Both edges are inclusive: a PR merged exactly `days` ago still counts.
export type Window = { readonly since: number; readonly until: number };

export const windowOf = (days: number, now: Date): Window => ({ since: now.getTime() - days * DAY_MS, until: now.getTime() });

const within = (iso: string, { since, until }: Window) => {
  const t = Date.parse(iso);
  return t >= since && t <= until;
};

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

// Useful fix = merged. Open PRs are reported but stay out of the rate: counting them would punish fresh work.
export function outcomeCounts(prs: readonly PullRequestRecord[], window: Window): OutcomeCounts {
  let opened = 0;
  let merged = 0;
  let closed = 0;
  let open = 0;
  const hoursToMerge: number[] = [];
  for (const pr of prs) {
    if (within(pr.createdAt, window)) opened++;
    const { lifecycle } = pr;
    switch (lifecycle.state) {
      case "open":
        open++;
        break;
      case "merged":
        if (within(lifecycle.mergedAt, window)) {
          merged++;
          hoursToMerge.push((Date.parse(lifecycle.mergedAt) - Date.parse(pr.createdAt)) / HOUR_MS);
        }
        break;
      case "closed":
        if (within(lifecycle.closedAt, window)) closed++;
        break;
      default: {
        const _exhaustive: never = lifecycle;
        throw new Error(`unknown PR state ${JSON.stringify(_exhaustive)}`);
      }
    }
  }
  const resolved = merged + closed;
  return { opened, merged, closed, open, usefulRate: resolved === 0 ? null : merged / resolved, medianHoursToMerge: median(hoursToMerge) };
}

// Monday 00:00 UTC of the week holding t.
export function weekStart(t: number): number {
  const day = new Date(t);
  const midnight = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  return midnight - ((day.getUTCDay() + 6) % 7) * DAY_MS;
}

export function weeklyBuckets(prs: readonly PullRequestRecord[], window: Window): OutcomeSummary["weekly"] {
  const buckets: { start: string; opened: number; merged: number; closed: number }[] = [];
  const first = weekStart(window.since);
  for (let start = first; start <= window.until; start += WEEK_MS) buckets.push({ start: new Date(start).toISOString(), opened: 0, merged: 0, closed: 0 });
  const bucketOf = (iso: string) => (within(iso, window) ? buckets[Math.floor((Date.parse(iso) - first) / WEEK_MS)] : undefined);
  for (const pr of prs) {
    const created = bucketOf(pr.createdAt);
    if (created) created.opened++;
    const { lifecycle } = pr;
    if (lifecycle.state === "merged") {
      const merged = bucketOf(lifecycle.mergedAt);
      if (merged) merged.merged++;
    } else if (lifecycle.state === "closed") {
      const closed = bucketOf(lifecycle.closedAt);
      if (closed) closed.closed++;
    }
  }
  return buckets;
}

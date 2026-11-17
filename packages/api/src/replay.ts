import type { RunRecord } from "@automation-server/core";

export const SCHEDULE_SOURCE = "schedule";

export type ReplayCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

// Shared by the API and the admin button so the two cannot disagree. Scheduled jobs carry no event, they re-run by job name.
export function canReplay(run: Pick<RunRecord, "status" | "source" | "hasEvent">): ReplayCheck {
  if (run.status === "running") return { ok: false, reason: "This run is still running" };
  if (run.status === "duplicate") return { ok: false, reason: "A duplicate run did nothing, so there is nothing to replay" };
  if (run.status === "succeeded") return { ok: false, reason: "Only failed runs can be replayed, a succeeded run already holds its claim" };
  if (run.source === SCHEDULE_SOURCE) return { ok: true };
  if (!run.hasEvent) return { ok: false, reason: "This run has no stored event" };
  return { ok: true };
}

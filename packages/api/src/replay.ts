import type { RunRecord } from "@automation-server/core";

export const SCHEDULE_SOURCE = "schedule";

export type ReplayCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export type ReplayMode = { readonly dryRun?: boolean };

// Shared by the API and the admin buttons so they cannot disagree. A real replay needs a failed run, because a succeeded one holds its claim.
// A real replay of a dry-run row is refused, so a preview can never turn into writes. A dry replay writes nothing, so any finished run with a stored event will do. Scheduled jobs carry no event and have no dry mode.
export function canReplay(run: Pick<RunRecord, "status" | "source" | "hasEvent" | "dryRun">, { dryRun = false }: ReplayMode = {}): ReplayCheck {
  if (run.status === "running") return { ok: false, reason: "This run is still running" };
  if (run.status === "duplicate") return { ok: false, reason: "A duplicate run did nothing, so there is nothing to replay" };
  if (dryRun) {
    if (run.source === SCHEDULE_SOURCE) return { ok: false, reason: "Scheduled jobs cannot be dry-run, they have no stored event to preview" };
    if (!run.hasEvent) return { ok: false, reason: "This run has no stored event" };
    return { ok: true };
  }
  if (run.dryRun) return { ok: false, reason: "A dry run never wrote a claim, so it can only be dry-run again. Replay the original run instead" };
  if (run.status === "succeeded") return { ok: false, reason: "Only failed runs can be replayed, a succeeded run already holds its claim" };
  if (run.source === SCHEDULE_SOURCE) return { ok: true };
  if (!run.hasEvent) return { ok: false, reason: "This run has no stored event" };
  return { ok: true };
}

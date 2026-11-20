import type {
  Origin,
  PullRequestLifecycle,
  RepoSyncState,
  WorkflowRunMatch,
  WorkRef,
} from "@automation-server/api/routers/index"

import { formatHours, hoursBetween } from "./format"

/** What a PR badge shows: an open PR splits into draft and ready, because a draft has not been offered for review yet. */
export type PrBadgeState = "draft" | "open" | "merged" | "closed"

export function prBadgeState(lifecycle: PullRequestLifecycle): PrBadgeState {
  switch (lifecycle.state) {
    case "open":
      return lifecycle.draft ? "draft" : "open"
    case "merged":
    case "closed":
      return lifecycle.state
    default: {
      const _exhaustive: never = lifecycle
      return _exhaustive
    }
  }
}

/** "merged in 6 h", "closed after 3 d", "open 2 d". */
export function prTiming(pr: { createdAt: string; lifecycle: PullRequestLifecycle }, nowIso: string) {
  const { lifecycle } = pr
  switch (lifecycle.state) {
    case "merged":
      return `merged in ${formatHours(hoursBetween(pr.createdAt, lifecycle.mergedAt))}`
    case "closed":
      return `closed after ${formatHours(hoursBetween(pr.createdAt, lifecycle.closedAt))}`
    case "open":
      return `open ${formatHours(hoursBetween(pr.createdAt, nowIso))}`
    default: {
      const _exhaustive: never = lifecycle
      return _exhaustive
    }
  }
}

/** The value outcomes.pullRequests filters on: an automation name or a producer id. */
export const originKey = (origin: Origin) => origin.name

export const ORIGIN_KIND_LABEL: Record<Origin["kind"], string> = {
  automation: "automation",
  workflow: "workflow only",
}

export function workRefLabel(ref: WorkRef) {
  switch (ref.kind) {
    case "github-issue":
      return `${ref.repo}#${ref.number}`
    case "linear-issue":
      return ref.identifier
    default: {
      const _exhaustive: never = ref
      return _exhaustive
    }
  }
}

export const MATCH_COPY: Record<WorkflowRunMatch, { label: string; detail: string }> = {
  exact: { label: "dispatch id", detail: "GitHub returned this run's id when the server dispatched it." },
  titled: { label: "by run name", detail: "The run's name carries the issue, so this is the run for it, though the dispatch returned no id." },
  linked: { label: "via PR body", detail: "A Codex PR names this run in its body. The run itself carried no other link." },
}

export type SyncStatus =
  | { kind: "never" }
  | { kind: "synced"; at: string }

/** The oldest sync across repositories: every repository is at least this fresh. A repository never synced makes the whole set unsynced. */
export function syncStatus(sync: readonly RepoSyncState[]): SyncStatus {
  let oldest: string | null = null
  for (const repo of sync) {
    if (!repo.syncedAt) return { kind: "never" }
    if (!oldest || repo.syncedAt < oldest) oldest = repo.syncedAt
  }
  return oldest ? { kind: "synced", at: oldest } : { kind: "never" }
}

export const syncErrors = (sync: readonly RepoSyncState[]) =>
  sync.flatMap((repo) => (repo.error ? [{ repo: repo.repo, error: repo.error }] : []))

/** The run page shows the Result card only when the run left something to follow. */
export const hasResult = (trace: { workItems: readonly unknown[]; llm: { calls: readonly unknown[] } }) => trace.workItems.length > 0 || trace.llm.calls.length > 0

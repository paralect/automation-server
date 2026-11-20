/** Integer millionths of a US dollar. Sums stay exact; the admin formats it. */
export type MicroUsd = number & { readonly __brand: "MicroUsd" };

/** "owner/name". */
export type RepoName = string & { readonly __brand: "RepoName" };

/** Canonical id of one unit of work: "gh:owner/repo#123" or "linear:ENG-42". The only join column between effects, workflow runs and PRs. */
export type WorkKey = string & { readonly __brand: "WorkKey" };

export type WorkRef =
  | { readonly kind: "github-issue"; readonly repo: RepoName; readonly number: number }
  | { readonly kind: "linear-issue"; readonly identifier: string };

export const OUTCOME_WINDOWS = [30, 90] as const;
export type OutcomeWindowDays = (typeof OUTCOME_WINDOWS)[number];

export const WORKFLOW_STATES = ["queued", "waiting", "running", "success", "failure", "cancelled", "skipped"] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

/** Which Codex workflow opened a PR. The list lives in producers.ts and is checked against github-actions/*.yml by a test. */
export type ProducerId = "codex-issue-fix" | "linear-implement" | "codex-seo-autopilot" | "codex-changelog";

/** Who gets credit for a PR: the first server automation that touched its work item, else the workflow that opened it. */
export type Origin =
  | { readonly kind: "automation"; readonly name: string }
  | { readonly kind: "workflow"; readonly name: ProducerId };

export type PullRequestLifecycle =
  | { readonly state: "open"; readonly draft: boolean }
  | { readonly state: "merged"; readonly mergedAt: string }
  | { readonly state: "closed"; readonly closedAt: string };

export type PullRequestState = PullRequestLifecycle["state"];

export type PullRequestRecord = {
  readonly repo: RepoName;
  readonly number: number;
  readonly producer: ProducerId;
  readonly workKey: WorkKey | null;
  readonly title: string;
  readonly url: string;
  readonly createdAt: string;
  readonly lifecycle: PullRequestLifecycle;
};

/** How a workflow run was tied to its work item. exact: the run id GitHub returned for our dispatch. titled: the run-name carries the key. linked: a PR body names the run. */
export type WorkflowRunMatch = "exact" | "titled" | "linked";

export type WorkflowRunRecord = {
  readonly repo: RepoName;
  readonly id: number;
  readonly producer: ProducerId;
  readonly runNumber: number;
  readonly title: string;
  readonly state: WorkflowState;
  readonly createdAt: string;
  readonly url: string;
  readonly link: { readonly workKey: WorkKey; readonly match: WorkflowRunMatch } | null;
};

export type OutcomeCounts = {
  /** PRs opened in the window. */
  readonly opened: number;
  /** PRs merged in the window, whenever they were opened. */
  readonly merged: number;
  /** PRs closed without merge in the window. */
  readonly closed: number;
  /** Open right now, not windowed. */
  readonly open: number;
  /** merged / (merged + closed); null when nothing was resolved in the window. */
  readonly usefulRate: number | null;
  /** Over PRs merged in the window, opened -> merged. */
  readonly medianHoursToMerge: number | null;
};

export type RepoSyncState = { readonly repo: RepoName; readonly syncedAt: string | null; readonly error: string | null };

export type OutcomeSummary = {
  readonly windowDays: OutcomeWindowDays;
  readonly overall: OutcomeCounts;
  readonly byOrigin: readonly (OutcomeCounts & { readonly origin: Origin })[];
  /** One bucket per ISO week (Monday, UTC) touching the window, oldest first. */
  readonly weekly: readonly { readonly start: string; readonly opened: number; readonly merged: number; readonly closed: number }[];
  readonly sync: readonly RepoSyncState[];
};

export type PullRequestRow = PullRequestRecord & {
  readonly seq: number;
  readonly origin: Origin;
  /** The run that started the work item, while the ledger knows it. The run itself may already be pruned. */
  readonly originRunId: string | null;
};

export type PullRequestQuery = {
  readonly project: string;
  readonly state?: PullRequestState;
  /** An automation name or a ProducerId. */
  readonly origin?: string;
  readonly before?: number;
  readonly limit: number;
};

export type LlmCall = {
  readonly provider: string;
  readonly model: string;
  /** What the call was for: the structured request name, such as "triage" or "agent_step". */
  readonly purpose: string;
  readonly generationId: string | null;
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** null when the provider reported no price. Such calls are counted as unpriced, never as free. */
  readonly cost: MicroUsd | null;
  readonly at: string;
  readonly durationMs: number;
};

export type LlmCallRow = LlmCall & { readonly id: number; readonly runId: string | null; readonly automation: string | null; readonly dryRun: boolean };

export type LlmTotals = {
  readonly calls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** Priced calls only. */
  readonly cost: MicroUsd;
  readonly unpriced: number;
};

export type WorkItemTrace = {
  readonly key: WorkKey;
  readonly ref: WorkRef;
  /** The issue's web URL (GitHub issue, or the Linear URL from the dispatch inputs), when known. */
  readonly url: string | null;
  /** This run created the issue, as opposed to dispatching work on an existing one. */
  readonly createdByThisRun: boolean;
  readonly dispatches: readonly { readonly at: string; readonly workflowFile: string; readonly ref: string }[];
  /** Every attempt, newest first. */
  readonly workflowRuns: readonly WorkflowRunRecord[];
  readonly pullRequests: readonly PullRequestRecord[];
  /** Dispatched over 30 minutes ago and no workflow run carries the key: GitHub likely dropped it from the codex-auth queue. */
  readonly missingRun: boolean;
};

export type RunTrace = {
  readonly runId: string;
  readonly workItems: readonly WorkItemTrace[];
  readonly llm: { readonly calls: readonly LlmCallRow[]; readonly totals: LlmTotals };
  /** Oldest sync time across the repositories involved, so the page can say "as of". null when never synced. */
  readonly syncedAt: string | null;
};

export const BUDGET_THRESHOLDS_PCT = [80, 100] as const;
export type BudgetThresholdPct = (typeof BUDGET_THRESHOLDS_PCT)[number];

export type CostMonth = {
  /** "2026-11", UTC. */
  readonly month: string;
  readonly totals: LlmTotals;
  /** null when no monthly budget is set. */
  readonly budget: MicroUsd | null;
  /** Linear projection of month-end spend from the days elapsed; null for a past month or before the first priced call. */
  readonly projected: MicroUsd | null;
  readonly alerts: readonly { readonly thresholdPct: BudgetThresholdPct; readonly sentAt: string }[];
  /** automation null = calls made outside any run. */
  readonly byAutomation: readonly (LlmTotals & { readonly automation: string | null; readonly runs: number })[];
  readonly byModel: readonly (LlmTotals & { readonly model: string })[];
  /** Every day of the month up to today (or the month end), zero-filled. */
  readonly daily: readonly { readonly day: string; readonly cost: MicroUsd }[];
  /** The costliest runs of the month, most expensive first, at most 10. */
  readonly topRuns: readonly { readonly runId: string; readonly automation: string | null; readonly at: string; readonly calls: number; readonly cost: MicroUsd }[];
};

export type SyncNowResult =
  | { readonly status: "succeeded" | "failed"; readonly runId: string | null; readonly message: string }
  | { readonly status: "busy" | "not-configured"; readonly message: string };

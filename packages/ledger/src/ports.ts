import type { Page } from "@automation-server/core";

import type { RunLink } from "./match";
import type {
  BudgetThresholdPct,
  CostMonth,
  LlmCall,
  MicroUsd,
  OutcomeSummary,
  OutcomeWindowDays,
  ProducerId,
  PullRequestQuery,
  PullRequestRecord,
  PullRequestRow,
  RepoName,
  RunTrace,
  WorkflowRunRecord,
  WorkKey,
} from "./types";

// The run a fact belongs to, copied onto the fact so attribution outlives the run row.
export type RecordScope = { readonly runId: string | null; readonly automation: string; readonly dryRun: boolean };

// What is kept of a GitHub write: the work key, never the dispatch inputs.
export type StoredEffect =
  | { readonly kind: "issue_created"; readonly repo: RepoName; readonly workKey: WorkKey; readonly url: string; readonly at: string }
  | {
      readonly kind: "workflow_dispatched";
      readonly repo: RepoName;
      readonly workKey: WorkKey | null;
      // The Linear issue URL from the dispatch inputs, when it is one.
      readonly url: string | null;
      readonly workflowFile: string;
      readonly ref: string;
      readonly workflowRunId: number | null;
      readonly at: string;
    };

// Each consumer gets only the port it uses, so no consumer writes a table it does not own.

// Writer of llm_calls and run_effects. Used only by the observer. Both writes are idempotent per natural key.
export type LedgerRecorder = {
  recordLlmCall(project: string, scope: RecordScope | null, call: LlmCall): void;
  recordEffect(project: string, scope: RecordScope | null, effect: StoredEffect): void;
};

// At-most-once budget alerts. Only a failed post releases a claim and nothing takes one over, so a posted alert is never posted again.
export type BudgetAlertPort = {
  monthSpend(project: string, month: string): MicroUsd;
  claimAlert(project: string, month: string, thresholdPct: BudgetThresholdPct, at: Date): boolean;
  markAlertSent(project: string, month: string, thresholdPct: BudgetThresholdPct, at: Date): void;
  releaseAlert(project: string, month: string, thresholdPct: BudgetThresholdPct): void;
};

// A read that hit its page cap stores where it stopped, so the next sync continues there instead of skipping what it never read.
export type PrResume = { readonly page: number; readonly newest: string | null };
export type RunResume = { readonly startedAt: string; readonly remaining: readonly { readonly producer: ProducerId; readonly before: string }[] };

export type SyncProgress = {
  // Newest PR updated_at of the last complete PR read.
  readonly prCursor: string | null;
  readonly prResume: PrResume | null;
  // When the last complete workflow run read started.
  readonly runCursor: string | null;
  readonly runResume: RunResume | null;
};

export const NO_SYNC_PROGRESS: SyncProgress = { prCursor: null, prResume: null, runCursor: null, runResume: null };

export type RepoSyncBatch = {
  readonly project: string;
  readonly repo: RepoName;
  readonly pullRequests: readonly PullRequestRecord[];
  readonly workflowRuns: readonly WorkflowRunRecord[];
  readonly progress: SyncProgress;
  readonly syncedAt: string;
  // A problem that did not stop the PRs from being applied, such as workflow runs the token cannot read.
  readonly error: string | null;
};

// Writer of pull_requests, workflow_runs and sync_state. Used only by the sync job.
export type LedgerSyncPort = {
  syncState(project: string, repo: RepoName): SyncProgress;
  dispatchedRuns(project: string, repo: RepoName, runIds: readonly number[]): ReadonlyMap<number, WorkKey>;
  runLinks(project: string, repo: RepoName, runIds: readonly number[]): ReadonlyMap<number, RunLink>;
  // One transaction: upsert PRs and runs, store the progress and the error.
  applyRepoSync(batch: RepoSyncBatch): void;
  recordSyncError(project: string, repo: RepoName, message: string, at: string): void;
};

export type LedgerReader = {
  trace(project: string, runId: string, now: Date): RunTrace;
  outcomes(project: string, windowDays: OutcomeWindowDays, now: Date): OutcomeSummary;
  pullRequests(query: PullRequestQuery): Page<PullRequestRow>;
  costs(project: string, month: string, budget: MicroUsd | null, now: Date): CostMonth;
};

export type Ledger = LedgerRecorder &
  BudgetAlertPort &
  LedgerSyncPort &
  LedgerReader & {
    prune(beforeIso: string): number;
    close(): void;
  };

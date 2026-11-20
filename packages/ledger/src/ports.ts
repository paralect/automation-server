import type { Page } from "@automation-server/core";

import type { RunLink } from "./match";
import type {
  BudgetThresholdPct,
  CostMonth,
  LlmCall,
  MicroUsd,
  OutcomeSummary,
  OutcomeWindowDays,
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

// Exactly-once budget alerts, with the claim store's lease semantics. A pending claim older than the lease is taken over.
export type BudgetAlertPort = {
  monthSpend(project: string, month: string): MicroUsd;
  claimAlert(project: string, month: string, thresholdPct: BudgetThresholdPct, at: Date): boolean;
  markAlertSent(project: string, month: string, thresholdPct: BudgetThresholdPct, at: Date): void;
  releaseAlert(project: string, month: string, thresholdPct: BudgetThresholdPct): void;
};

export type RepoSyncBatch = {
  readonly project: string;
  readonly repo: RepoName;
  readonly pullRequests: readonly PullRequestRecord[];
  readonly workflowRuns: readonly WorkflowRunRecord[];
  // Newest PR updated_at seen. null keeps the stored cursor.
  readonly prCursor: string | null;
  readonly syncedAt: string;
};

// Writer of pull_requests, workflow_runs and sync_state. Used only by the sync job.
export type LedgerSyncPort = {
  syncState(project: string, repo: RepoName): { readonly prCursor: string | null; readonly syncedAt: string | null };
  dispatchedRuns(project: string, repo: RepoName, runIds: readonly number[]): ReadonlyMap<number, WorkKey>;
  runLinks(project: string, repo: RepoName, runIds: readonly number[]): ReadonlyMap<number, RunLink>;
  // One transaction: upsert PRs and runs, advance the cursor, clear the error.
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

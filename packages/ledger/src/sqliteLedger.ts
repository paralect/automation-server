import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { migrate } from "@automation-server/core/sqliteSchema";
import { z } from "zod";

import { monthBounds, monthOf, projectedSpend } from "./budget";
import { microUsd } from "./facts";
import type { RunLink } from "./match";
import { DAY_MS, outcomeCounts, weeklyBuckets, windowOf } from "./metrics";
import type { Ledger, PrResume, RecordScope, RunResume, StoredEffect } from "./ports";
import { isProducerId } from "./producers";
import {
  BUDGET_THRESHOLDS_PCT,
  type BudgetThresholdPct,
  type CostMonth,
  type LlmCallRow,
  type LlmTotals,
  type Origin,
  type OutcomeCounts,
  type ProducerId,
  type PullRequestLifecycle,
  type PullRequestRecord,
  type PullRequestRow,
  type RepoName,
  type WorkflowRunMatch,
  type WorkflowRunRecord,
  type WorkItemTrace,
  type WorkKey,
} from "./types";
import { isWorkflowState } from "./workflowState";
import { isRepoName, parseWorkKey, workKey } from "./workKey";

export type SqliteLedgerOptions = { path: string };

// GitHub drops a queued run when a newer one replaces it in the codex-auth concurrency group.
const MISSING_RUN_AFTER_MS = 30 * 60_000;
const CLOCK_SKEW_MS = 2 * 60_000;
const TOP_RUNS = 10;

type LlmRow = {
  id: number;
  run_id: string | null;
  automation: string | null;
  dry_run: number;
  at: string;
  provider: string;
  model: string;
  purpose: string;
  generation_id: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  cost_micros: number | null;
  duration_ms: number;
};

type TotalsRow = { calls: number; prompt_tokens: number | null; completion_tokens: number | null; cost: number | null; unpriced: number | null };

type EffectRow = {
  id: number;
  kind: StoredEffect["kind"];
  repo: string;
  work_key: string | null;
  url: string | null;
  workflow_file: string | null;
  ref: string | null;
  workflow_run_id: number | null;
  at: string;
};

type RunRow = {
  repo: string;
  id: number;
  producer: string;
  run_number: number;
  title: string;
  state: string;
  created_at: string;
  url: string;
  work_key: string | null;
  match: WorkflowRunMatch | null;
};

type PrRow = {
  seq: number;
  repo: string;
  number: number;
  producer: string;
  work_key: string | null;
  title: string;
  url: string;
  created_at: string;
  state: "open" | "merged" | "closed";
  draft: number | null;
  merged_at: string | null;
  closed_at: string | null;
  origin_automation: string | null;
  origin_run_id: string | null;
};

// Rows were written through CHECK constraints by this file, so a mismatch here means a corrupt database.
function corrupt(what: string, value: unknown): never {
  throw new Error(`ledger row has an invalid ${what}: ${JSON.stringify(value)}`);
}

const repoOf = (value: string): RepoName => (isRepoName(value) ? value : corrupt("repo", value));
const producerOf = (value: string): ProducerId => (isProducerId(value) ? value : corrupt("producer", value));

function keyOf(value: string): WorkKey {
  const ref = parseWorkKey(value);
  return ref ? workKey(ref) : corrupt("work key", value);
}

const prResumeSchema: z.ZodType<PrResume> = z.object({ page: z.number().int().min(1), newest: z.string().nullable() });
const runResumeSchema: z.ZodType<RunResume> = z.object({
  startedAt: z.string(),
  remaining: z.array(z.object({ producer: z.string().refine(isProducerId).transform(producerOf), before: z.string() })),
});

function resumeOf<T>(schema: z.ZodType<T>, what: string, value: string | null): T | null {
  if (value === null) return null;
  const parsed = schema.safeParse(JSON.parse(value));
  return parsed.success ? parsed.data : corrupt(what, value);
}

function lifecycleOf(row: PrRow): PullRequestLifecycle {
  switch (row.state) {
    case "open":
      return { state: "open", draft: row.draft === 1 };
    case "merged":
      return { state: "merged", mergedAt: row.merged_at ?? corrupt("merged_at", row) };
    case "closed":
      return { state: "closed", closedAt: row.closed_at ?? corrupt("closed_at", row) };
    default: {
      const _exhaustive: never = row.state;
      return corrupt("state", _exhaustive);
    }
  }
}

const toPullRequest = (row: PrRow): PullRequestRecord => ({
  repo: repoOf(row.repo),
  number: row.number,
  producer: producerOf(row.producer),
  workKey: row.work_key === null ? null : keyOf(row.work_key),
  title: row.title,
  url: row.url,
  createdAt: row.created_at,
  lifecycle: lifecycleOf(row),
});

// Credit goes to the first server automation that touched the work item, else to the workflow that opened the PR.
const originOf = (row: PrRow, producer: ProducerId): Origin =>
  row.origin_automation === null ? { kind: "workflow", name: producer } : { kind: "automation", name: row.origin_automation };

const toPullRequestRow = (row: PrRow): PullRequestRow => {
  const pr = toPullRequest(row);
  return { ...pr, seq: row.seq, origin: originOf(row, pr.producer), originRunId: row.origin_run_id };
};

const toWorkflowRun = (row: RunRow): WorkflowRunRecord => ({
  repo: repoOf(row.repo),
  id: row.id,
  producer: producerOf(row.producer),
  runNumber: row.run_number,
  title: row.title,
  state: isWorkflowState(row.state) ? row.state : corrupt("workflow state", row.state),
  createdAt: row.created_at,
  url: row.url,
  link: row.work_key === null || row.match === null ? null : { workKey: keyOf(row.work_key), match: row.match },
});

const toLlmCall = (row: LlmRow): LlmCallRow => ({
  id: row.id,
  runId: row.run_id,
  automation: row.automation,
  dryRun: row.dry_run === 1,
  provider: row.provider,
  model: row.model,
  purpose: row.purpose,
  generationId: row.generation_id,
  promptTokens: row.prompt_tokens,
  completionTokens: row.completion_tokens,
  cost: row.cost_micros === null ? null : microUsd(row.cost_micros),
  at: row.at,
  durationMs: row.duration_ms,
});

const toTotals = (row: TotalsRow | null): LlmTotals => ({
  calls: row?.calls ?? 0,
  promptTokens: row?.prompt_tokens ?? 0,
  completionTokens: row?.completion_tokens ?? 0,
  cost: microUsd(row?.cost ?? 0),
  unpriced: row?.unpriced ?? 0,
});

const isThreshold = (value: number): value is BudgetThresholdPct => BUDGET_THRESHOLDS_PCT.some((pct) => pct === value);

const iso = (value: string) => new Date(value).toISOString();
const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

const TOTALS = `COUNT(*) AS calls, SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens,
  SUM(cost_micros) AS cost, SUM(cost_micros IS NULL) AS unpriced`;

// Origin is derived at read time from the earliest effect carrying the PR's work key, so a late dispatch or a pruned run never leaves a stale copy.
const PRS_WITH_ORIGIN = `
  WITH first_effect AS (
    SELECT work_key, automation, run_id, ROW_NUMBER() OVER (PARTITION BY work_key ORDER BY at, id) AS rn
    FROM run_effects WHERE project = $project AND work_key IS NOT NULL AND automation IS NOT NULL
  )
  SELECT pr.seq, pr.repo, pr.number, pr.producer, pr.work_key, pr.title, pr.url, pr.created_at, pr.state, pr.draft, pr.merged_at, pr.closed_at,
         fe.automation AS origin_automation, fe.run_id AS origin_run_id
  FROM pull_requests pr LEFT JOIN first_effect fe ON fe.work_key = pr.work_key AND fe.rn = 1
  WHERE pr.project = $project`;

export function createSqliteLedger({ path }: SqliteLedgerOptions): Ledger {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA journal_mode = WAL");
  migrate(db, "ledger", [
    (db) => {
      db.run(`CREATE TABLE llm_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        run_id TEXT,
        automation TEXT,
        dry_run INTEGER NOT NULL DEFAULT 0,
        at TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        purpose TEXT NOT NULL,
        generation_id TEXT UNIQUE,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        cost_micros INTEGER CHECK (cost_micros IS NULL OR cost_micros >= 0),
        duration_ms INTEGER NOT NULL
      )`);
      db.run("CREATE INDEX llm_calls_project_at ON llm_calls (project, at)");
      db.run("CREATE INDEX llm_calls_run ON llm_calls (run_id)");

      db.run(`CREATE TABLE run_effects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        run_id TEXT,
        automation TEXT,
        at TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('issue_created', 'workflow_dispatched')),
        repo TEXT NOT NULL,
        work_key TEXT,
        url TEXT,
        workflow_file TEXT,
        ref TEXT,
        workflow_run_id INTEGER,
        CHECK ((kind = 'issue_created') = (work_key IS NOT NULL AND url IS NOT NULL AND workflow_file IS NULL)),
        CHECK ((kind = 'workflow_dispatched') = (workflow_file IS NOT NULL AND ref IS NOT NULL))
      )`);
      db.run("CREATE INDEX run_effects_run ON run_effects (run_id)");
      db.run("CREATE INDEX run_effects_project_key ON run_effects (project, work_key, at)");
      db.run("CREATE INDEX run_effects_at ON run_effects (at)");
      // An issue is created once, and GitHub hands out a run id once, so a re-delivered observation is a no-op.
      db.run("CREATE UNIQUE INDEX run_effects_one_issue ON run_effects (project, work_key) WHERE kind = 'issue_created'");
      db.run("CREATE UNIQUE INDEX run_effects_one_run ON run_effects (project, repo, workflow_run_id) WHERE workflow_run_id IS NOT NULL");

      db.run(`CREATE TABLE workflow_runs (
        project TEXT NOT NULL,
        repo TEXT NOT NULL,
        id INTEGER NOT NULL,
        producer TEXT NOT NULL,
        run_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'waiting', 'running', 'success', 'failure', 'cancelled', 'skipped')),
        created_at TEXT NOT NULL,
        url TEXT NOT NULL,
        work_key TEXT,
        match TEXT CHECK (match IN ('exact', 'titled', 'linked')),
        PRIMARY KEY (project, repo, id),
        CHECK ((work_key IS NULL) = (match IS NULL))
      )`);
      db.run("CREATE INDEX workflow_runs_key ON workflow_runs (project, work_key)");
      db.run("CREATE INDEX workflow_runs_created ON workflow_runs (created_at)");

      db.run(`CREATE TABLE pull_requests (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        producer TEXT NOT NULL,
        work_key TEXT,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open', 'merged', 'closed')),
        draft INTEGER,
        merged_at TEXT,
        closed_at TEXT,
        UNIQUE (project, repo, number),
        CHECK ((state = 'open') = (draft IS NOT NULL)),
        CHECK ((state = 'merged') = (merged_at IS NOT NULL)),
        CHECK ((state = 'closed') = (closed_at IS NOT NULL))
      )`);
      db.run("CREATE INDEX pull_requests_key ON pull_requests (project, work_key)");
      db.run("CREATE INDEX pull_requests_created ON pull_requests (project, created_at)");

      db.run(`CREATE TABLE sync_state (
        project TEXT NOT NULL,
        repo TEXT NOT NULL,
        pr_cursor TEXT,
        synced_at TEXT,
        error TEXT,
        error_at TEXT,
        PRIMARY KEY (project, repo)
      )`);

      db.run(`CREATE TABLE budget_alerts (
        project TEXT NOT NULL,
        month TEXT NOT NULL,
        threshold_pct INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sent')),
        at TEXT NOT NULL,
        PRIMARY KEY (project, month, threshold_pct)
      )`);
    },
    (db) => {
      db.run("ALTER TABLE sync_state ADD COLUMN pr_resume TEXT");
      db.run("ALTER TABLE sync_state ADD COLUMN run_cursor TEXT");
      db.run("ALTER TABLE sync_state ADD COLUMN run_resume TEXT");
    },
  ]);

  const insertLlm = db.query(
    `INSERT INTO llm_calls (project, run_id, automation, dry_run, at, provider, model, purpose, generation_id, prompt_tokens, completion_tokens, cost_micros, duration_ms)
     VALUES ($project, $runId, $automation, $dryRun, $at, $provider, $model, $purpose, $generationId, $promptTokens, $completionTokens, $cost, $durationMs)
     ON CONFLICT DO NOTHING`,
  );
  const insertEffect = db.query(
    `INSERT INTO run_effects (project, run_id, automation, at, kind, repo, work_key, url, workflow_file, ref, workflow_run_id)
     VALUES ($project, $runId, $automation, $at, $kind, $repo, $workKey, $url, $workflowFile, $ref, $workflowRunId)
     ON CONFLICT DO NOTHING`,
  );

  const spendIn = db.query<{ cost: number | null }, { $project: string; $start: string; $end: string }>(
    "SELECT SUM(cost_micros) AS cost FROM llm_calls WHERE project = $project AND at >= $start AND at < $end",
  );
  // A pending claim left by a crash cannot tell "never posted" from "posted, not yet marked", so it is never taken over.
  const claim = db.query(
    `INSERT INTO budget_alerts (project, month, threshold_pct, status, at) VALUES ($project, $month, $pct, 'pending', $at)
     ON CONFLICT (project, month, threshold_pct) DO NOTHING`,
  );
  const markSent = db.query("UPDATE budget_alerts SET status = 'sent', at = $at WHERE project = $project AND month = $month AND threshold_pct = $pct");
  const release = db.query("DELETE FROM budget_alerts WHERE project = $project AND month = $month AND threshold_pct = $pct AND status = 'pending'");

  const syncStateOf = db.query<{ pr_cursor: string | null; pr_resume: string | null; run_cursor: string | null; run_resume: string | null }, { $project: string; $repo: string }>(
    "SELECT pr_cursor, pr_resume, run_cursor, run_resume FROM sync_state WHERE project = $project AND repo = $repo",
  );
  const upsertPr = db.query(
    `INSERT INTO pull_requests (project, repo, number, producer, work_key, title, url, created_at, state, draft, merged_at, closed_at)
     VALUES ($project, $repo, $number, $producer, $workKey, $title, $url, $createdAt, $state, $draft, $mergedAt, $closedAt)
     ON CONFLICT (project, repo, number) DO UPDATE SET
       producer = excluded.producer, work_key = COALESCE(excluded.work_key, pull_requests.work_key), title = excluded.title, url = excluded.url,
       created_at = excluded.created_at, state = excluded.state, draft = excluded.draft, merged_at = excluded.merged_at, closed_at = excluded.closed_at`,
  );
  const upsertRun = db.query(
    `INSERT INTO workflow_runs (project, repo, id, producer, run_number, title, state, created_at, url, work_key, match)
     VALUES ($project, $repo, $id, $producer, $runNumber, $title, $state, $createdAt, $url, $workKey, $match)
     ON CONFLICT (project, repo, id) DO UPDATE SET
       producer = excluded.producer, run_number = excluded.run_number, title = excluded.title, state = excluded.state,
       created_at = excluded.created_at, url = excluded.url, work_key = excluded.work_key, match = excluded.match`,
  );
  const synced = db.query(
    `INSERT INTO sync_state (project, repo, pr_cursor, pr_resume, run_cursor, run_resume, synced_at, error, error_at)
     VALUES ($project, $repo, $prCursor, $prResume, $runCursor, $runResume, $at, $error, $errorAt)
     ON CONFLICT (project, repo) DO UPDATE SET pr_cursor = excluded.pr_cursor, pr_resume = excluded.pr_resume, run_cursor = excluded.run_cursor,
       run_resume = excluded.run_resume, synced_at = excluded.synced_at, error = excluded.error, error_at = excluded.error_at`,
  );
  const syncFailed = db.query(
    `INSERT INTO sync_state (project, repo, error, error_at) VALUES ($project, $repo, $error, $at)
     ON CONFLICT (project, repo) DO UPDATE SET error = excluded.error, error_at = excluded.error_at`,
  );

  const runEffects = db.query<EffectRow, { $project: string; $runId: string }>(
    "SELECT id, kind, repo, work_key, url, workflow_file, ref, workflow_run_id, at FROM run_effects WHERE project = $project AND run_id = $runId ORDER BY at, id",
  );
  const keyEffects = db.query<EffectRow, { $project: string; $key: string }>(
    "SELECT id, kind, repo, work_key, url, workflow_file, ref, workflow_run_id, at FROM run_effects WHERE project = $project AND work_key = $key ORDER BY at DESC, id DESC",
  );
  const keyRuns = db.query<RunRow, { $project: string; $key: string }>(
    "SELECT * FROM workflow_runs WHERE project = $project AND work_key = $key ORDER BY created_at DESC, id DESC",
  );
  const keyPrs = db.query<PrRow, { $project: string; $key: string }>(
    `SELECT seq, repo, number, producer, work_key, title, url, created_at, state, draft, merged_at, closed_at, NULL AS origin_automation, NULL AS origin_run_id
     FROM pull_requests WHERE project = $project AND work_key = $key ORDER BY created_at DESC`,
  );
  const runLlm = db.query<LlmRow, { $project: string; $runId: string }>("SELECT * FROM llm_calls WHERE project = $project AND run_id = $runId ORDER BY at, id");
  const runLlmTotals = db.query<TotalsRow, { $project: string; $runId: string }>(`SELECT ${TOTALS} FROM llm_calls WHERE project = $project AND run_id = $runId`);
  const repoSync = db.query<{ repo: string; synced_at: string | null; error: string | null }, { $project: string }>(
    "SELECT repo, synced_at, error FROM sync_state WHERE project = $project ORDER BY repo",
  );

  const outcomePrs = db.query<PrRow, { $project: string; $since: string }>(
    `${PRS_WITH_ORIGIN} AND (pr.state = 'open' OR pr.created_at >= $since OR pr.merged_at >= $since OR pr.closed_at >= $since)`,
  );
  type PrFilters = { $project: string; $state: string | null; $origin: string | null };
  const prPage = db.query<PrRow, PrFilters & { $before: string | null; $tieAt: string | null; $tieSeq: number | null; $limit: number }>(
    `${PRS_WITH_ORIGIN}
       AND ($state IS NULL OR pr.state = $state)
       AND ($origin IS NULL OR COALESCE(fe.automation, pr.producer) = $origin)
       AND ($before IS NULL OR pr.created_at < $before)
       AND ($tieAt IS NULL OR (pr.created_at = $tieAt AND pr.seq < $tieSeq))
     ORDER BY pr.created_at DESC, pr.seq DESC LIMIT $limit`,
  );

  type Range = { $project: string; $start: string; $end: string };
  const monthTotals = db.query<TotalsRow, Range>(`SELECT ${TOTALS} FROM llm_calls WHERE project = $project AND at >= $start AND at < $end`);
  const byAutomation = db.query<TotalsRow & { automation: string | null; runs: number }, Range>(
    `SELECT automation, COUNT(DISTINCT run_id) AS runs, ${TOTALS} FROM llm_calls WHERE project = $project AND at >= $start AND at < $end
     GROUP BY automation ORDER BY COALESCE(SUM(cost_micros), 0) DESC, automation`,
  );
  const byModel = db.query<TotalsRow & { model: string }, Range>(
    `SELECT model, ${TOTALS} FROM llm_calls WHERE project = $project AND at >= $start AND at < $end GROUP BY model ORDER BY COALESCE(SUM(cost_micros), 0) DESC, model`,
  );
  const daily = db.query<{ day: string; cost: number | null }, Range>(
    "SELECT substr(at, 1, 10) AS day, SUM(cost_micros) AS cost FROM llm_calls WHERE project = $project AND at >= $start AND at < $end GROUP BY day",
  );
  const topRuns = db.query<{ run_id: string; automation: string | null; at: string; calls: number; cost: number }, Range & { $limit: number }>(
    `SELECT run_id, MIN(automation) AS automation, MIN(at) AS at, COUNT(*) AS calls, COALESCE(SUM(cost_micros), 0) AS cost
     FROM llm_calls WHERE project = $project AND at >= $start AND at < $end AND run_id IS NOT NULL
     GROUP BY run_id ORDER BY cost DESC, at DESC LIMIT $limit`,
  );
  const sentAlerts = db.query<{ threshold_pct: number; at: string }, { $project: string; $month: string }>(
    "SELECT threshold_pct, at FROM budget_alerts WHERE project = $project AND month = $month AND status = 'sent' ORDER BY threshold_pct",
  );

  const scopeParams = (scope: RecordScope | null) => ({ $runId: scope?.runId ?? null, $automation: scope?.automation ?? null });

  const ledger: Ledger = {
    recordLlmCall(project, scope, call) {
      insertLlm.run({
        $project: project,
        ...scopeParams(scope),
        $dryRun: scope?.dryRun ? 1 : 0,
        $at: iso(call.at),
        $provider: call.provider,
        $model: call.model,
        $purpose: call.purpose,
        $generationId: call.generationId,
        $promptTokens: call.promptTokens,
        $completionTokens: call.completionTokens,
        $cost: call.cost,
        $durationMs: Math.round(call.durationMs),
      });
    },

    recordEffect(project, scope, effect) {
      const common = { $project: project, ...scopeParams(scope), $at: iso(effect.at), $kind: effect.kind, $repo: effect.repo, $workKey: effect.workKey, $url: effect.url };
      if (effect.kind === "issue_created") {
        insertEffect.run({ ...common, $workflowFile: null, $ref: null, $workflowRunId: null });
      } else {
        insertEffect.run({ ...common, $workflowFile: effect.workflowFile, $ref: effect.ref, $workflowRunId: effect.workflowRunId });
      }
    },

    monthSpend(project, month) {
      const { start, end } = monthBounds(month);
      return microUsd(spendIn.get({ $project: project, $start: start.toISOString(), $end: end.toISOString() })?.cost ?? 0);
    },

    claimAlert(project, month, pct, at) {
      return claim.run({ $project: project, $month: month, $pct: pct, $at: at.toISOString() }).changes > 0;
    },
    markAlertSent(project, month, pct, at) {
      markSent.run({ $project: project, $month: month, $pct: pct, $at: at.toISOString() });
    },
    releaseAlert(project, month, pct) {
      release.run({ $project: project, $month: month, $pct: pct });
    },

    syncState(project, repo) {
      const row = syncStateOf.get({ $project: project, $repo: repo });
      return {
        prCursor: row?.pr_cursor ?? null,
        prResume: resumeOf(prResumeSchema, "PR resume", row?.pr_resume ?? null),
        runCursor: row?.run_cursor ?? null,
        runResume: resumeOf(runResumeSchema, "run resume", row?.run_resume ?? null),
      };
    },

    dispatchedRuns(project, repo, runIds) {
      if (runIds.length === 0) return new Map();
      const rows = db
        .query<{ workflow_run_id: number; work_key: string }, (string | number)[]>(
          `SELECT workflow_run_id, work_key FROM run_effects
           WHERE project = ? AND repo = ? AND work_key IS NOT NULL AND workflow_run_id IN (${placeholders(runIds.length)})`,
        )
        .all(project, repo, ...runIds);
      return new Map(rows.map((r) => [r.workflow_run_id, keyOf(r.work_key)]));
    },

    runLinks(project, repo, runIds) {
      if (runIds.length === 0) return new Map();
      const rows = db
        .query<RunRow, (string | number)[]>(`SELECT * FROM workflow_runs WHERE project = ? AND repo = ? AND work_key IS NOT NULL AND id IN (${placeholders(runIds.length)})`)
        .all(project, repo, ...runIds);
      const links = new Map<number, RunLink>();
      for (const row of rows) {
        const { link } = toWorkflowRun(row);
        if (link) links.set(row.id, link);
      }
      return links;
    },

    applyRepoSync: (batch) =>
      db
        .transaction(() => {
          const base = { $project: batch.project, $repo: batch.repo };
          for (const pr of batch.pullRequests) {
            const { lifecycle } = pr;
            upsertPr.run({
              ...base,
              $number: pr.number,
              $producer: pr.producer,
              $workKey: pr.workKey,
              $title: pr.title,
              $url: pr.url,
              $createdAt: iso(pr.createdAt),
              $state: lifecycle.state,
              $draft: lifecycle.state === "open" ? (lifecycle.draft ? 1 : 0) : null,
              $mergedAt: lifecycle.state === "merged" ? iso(lifecycle.mergedAt) : null,
              $closedAt: lifecycle.state === "closed" ? iso(lifecycle.closedAt) : null,
            });
          }
          for (const run of batch.workflowRuns) {
            upsertRun.run({
              ...base,
              $id: run.id,
              $producer: run.producer,
              $runNumber: run.runNumber,
              $title: run.title,
              $state: run.state,
              $createdAt: iso(run.createdAt),
              $url: run.url,
              $workKey: run.link?.workKey ?? null,
              $match: run.link?.match ?? null,
            });
          }
          const { progress } = batch;
          synced.run({
            ...base,
            $prCursor: progress.prCursor,
            $prResume: progress.prResume && JSON.stringify(progress.prResume),
            $runCursor: progress.runCursor,
            $runResume: progress.runResume && JSON.stringify(progress.runResume),
            $at: batch.syncedAt,
            $error: batch.error,
            $errorAt: batch.error === null ? null : batch.syncedAt,
          });
        })
        .immediate(),

    recordSyncError(project, repo, message, at) {
      syncFailed.run({ $project: project, $repo: repo, $error: message, $at: at });
    },

    trace(project, runId, now) {
      const effects = runEffects.all({ $project: project, $runId: runId });
      const keys = [...new Set(effects.flatMap((e) => (e.work_key === null ? [] : [e.work_key])))];
      const repos = new Set(effects.map((e) => e.repo));
      const workItems = keys.map((raw): WorkItemTrace => {
        const key = keyOf(raw);
        const ref = parseWorkKey(key) ?? corrupt("work key", key);
        if (ref.kind === "github-issue") repos.add(ref.repo);
        const all = keyEffects.all({ $project: project, $key: key });
        const dispatches = all.filter((e) => e.kind === "workflow_dispatched");
        const workflowRuns = keyRuns.all({ $project: project, $key: key }).map(toWorkflowRun);
        const pullRequests = keyPrs.all({ $project: project, $key: key }).map(toPullRequest);
        const latest = dispatches[0];
        const seenAfter = (at: string) => Date.parse(at) >= Date.parse(latest?.at ?? "") - CLOCK_SKEW_MS;
        const missingRun =
          latest !== undefined &&
          latest.workflow_run_id === null &&
          now.getTime() - Date.parse(latest.at) > MISSING_RUN_AFTER_MS &&
          !workflowRuns.some((r) => seenAfter(r.createdAt)) &&
          !pullRequests.some((pr) => seenAfter(pr.createdAt));
        return {
          key,
          ref,
          url: all.find((e) => e.kind === "issue_created")?.url ?? all.find((e) => e.url !== null)?.url ?? null,
          createdByThisRun: effects.some((e) => e.kind === "issue_created" && e.work_key === key),
          dispatches: dispatches.map((e) => ({ at: e.at, workflowFile: e.workflow_file ?? corrupt("workflow file", e), ref: e.ref ?? corrupt("ref", e) })),
          workflowRuns,
          pullRequests,
          missingRun,
        };
      });
      const state = new Map(repoSync.all({ $project: project }).map((r) => [r.repo, r.synced_at]));
      const times = [...repos].map((repo) => state.get(repo) ?? null);
      const syncedAt = times.length === 0 || times.includes(null) ? null : ([...times].sort()[0] ?? null);
      return {
        runId,
        workItems,
        llm: { calls: runLlm.all({ $project: project, $runId: runId }).map(toLlmCall), totals: toTotals(runLlmTotals.get({ $project: project, $runId: runId })) },
        syncedAt,
      };
    },

    outcomes(project, windowDays, now) {
      const window = windowOf(windowDays, now);
      const rows = outcomePrs.all({ $project: project, $since: new Date(window.since).toISOString() });
      const prs = rows.map(toPullRequestRow);
      const groups = new Map<string, { origin: Origin; prs: PullRequestRecord[] }>();
      for (const pr of prs) {
        const id = `${pr.origin.kind}:${pr.origin.name}`;
        const group = groups.get(id) ?? { origin: pr.origin, prs: [] };
        group.prs.push(pr);
        groups.set(id, group);
      }
      const byOrigin: (OutcomeCounts & { origin: Origin })[] = [...groups.values()]
        .map(({ origin, prs: inGroup }) => ({ origin, ...outcomeCounts(inGroup, window) }))
        .sort((a, b) => b.opened + b.merged + b.closed + b.open - (a.opened + a.merged + a.closed + a.open) || a.origin.name.localeCompare(b.origin.name));
      return {
        windowDays,
        overall: outcomeCounts(prs, window),
        byOrigin,
        weekly: weeklyBuckets(prs, window),
        sync: repoSync.all({ $project: project }).map((r) => ({ repo: repoOf(r.repo), syncedAt: r.synced_at, error: r.error })),
      };
    },

    pullRequests({ project, state, origin, before, limit }) {
      // The cursor is the last PR's created_at in epoch ms, so it still pages after that PR is pruned. PRs sharing it all go on this page.
      const filters: PrFilters = { $project: project, $state: state ?? null, $origin: origin ?? null };
      const rows = prPage.all({ ...filters, $before: before === undefined ? null : new Date(before).toISOString(), $tieAt: null, $tieSeq: null, $limit: limit });
      const last = rows.at(-1);
      if (!last || rows.length < limit) return { items: rows.map(toPullRequestRow), nextCursor: null };
      const ties = prPage.all({ ...filters, $before: null, $tieAt: last.created_at, $tieSeq: last.seq, $limit: -1 });
      const more = prPage.all({ ...filters, $before: last.created_at, $tieAt: null, $tieSeq: null, $limit: 1 }).length > 0;
      return { items: [...rows, ...ties].map(toPullRequestRow), nextCursor: more ? Date.parse(last.created_at) : null };
    },

    costs(project, month, budget, now): CostMonth {
      const { start, end } = monthBounds(month);
      const range = { $project: project, $start: start.toISOString(), $end: end.toISOString() };
      const totals = toTotals(monthTotals.get(range));
      const costByDay = new Map(daily.all(range).map((r) => [r.day, r.cost ?? 0]));
      const lastDay = Math.min(end.getTime() - DAY_MS, Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const days: { day: string; cost: CostMonth["totals"]["cost"] }[] = [];
      for (let t = start.getTime(); t <= lastDay; t += DAY_MS) {
        const day = new Date(t).toISOString().slice(0, 10);
        days.push({ day, cost: microUsd(costByDay.get(day) ?? 0) });
      }
      return {
        month,
        totals,
        budget,
        projected: projectedSpend(totals.cost, month, now),
        alerts: sentAlerts
          .all({ $project: project, $month: month })
          .map((r) => ({ thresholdPct: isThreshold(r.threshold_pct) ? r.threshold_pct : corrupt("threshold", r.threshold_pct), sentAt: r.at })),
        byAutomation: byAutomation.all(range).map((r) => ({ automation: r.automation, runs: r.runs, ...toTotals(r) })),
        byModel: byModel.all(range).map((r) => ({ model: r.model, ...toTotals(r) })),
        daily: days,
        topRuns: topRuns
          .all({ ...range, $limit: TOP_RUNS })
          .map((r) => ({ runId: r.run_id, automation: r.automation, at: r.at, calls: r.calls, cost: microUsd(r.cost) })),
      };
    },

    prune(beforeIso) {
      const cutoff = Date.parse(beforeIso);
      if (Number.isNaN(cutoff)) throw new Error(`invalid prune cutoff: ${beforeIso}`);
      const before = new Date(cutoff).toISOString();
      return db
        .transaction(() => {
          let removed = 0;
          removed += db.query("DELETE FROM llm_calls WHERE at < $before").run({ $before: before }).changes;
          // Open PRs stay however old they are: they still count as open.
          removed += db.query("DELETE FROM pull_requests WHERE state != 'open' AND COALESCE(merged_at, closed_at) < $before").run({ $before: before }).changes;
          // A kept PR's origin is read from the effects on its work key, so those effects stay with it.
          removed += db
            .query(
              `DELETE FROM run_effects WHERE at < $before
               AND (work_key IS NULL OR NOT EXISTS (SELECT 1 FROM pull_requests pr WHERE pr.project = run_effects.project AND pr.work_key = run_effects.work_key))`,
            )
            .run({ $before: before }).changes;
          removed += db.query("DELETE FROM workflow_runs WHERE created_at < $before").run({ $before: before }).changes;
          removed += db.query("DELETE FROM budget_alerts WHERE month < $month").run({ $month: monthOf(new Date(cutoff)) }).changes;
          return removed;
        })
        .immediate();
    },

    close() {
      db.close();
    },
  };
  return ledger;
}

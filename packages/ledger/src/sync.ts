import type { Job, Logger } from "@automation-server/core";
import { z } from "zod";

import { linkRuns, type FetchedRun } from "./match";
import { DAY_MS } from "./metrics";
import type { LedgerSyncPort, RunResume, SyncProgress } from "./ports";
import { PR_PRODUCERS, producerOfBranch } from "./producers";
import type { ProducerId, PullRequestLifecycle, PullRequestRecord, RepoName, WorkflowRunRecord, WorkKey } from "./types";
import { toWorkflowState } from "./workflowState";
import { workflowRunIdFromBody, workKeyFromPullRequest } from "./workKey";

export const OUTCOME_SYNC_JOB = "outcome-sync";

// The first sync reaches as far back as the longest metric window.
const BACKFILL_DAYS = 90;
// Workflow runs finish within 30 minutes, so each sync re-reads two days before the last complete run read to catch late states.
const RUN_LOOKBACK_DAYS = 2;
const PR_OVERLAP_MS = 60 * 60_000;
const PAGE_SIZE = 100;
const MAX_PR_PAGES = 10;
const MAX_RUN_PAGES = 3;
const TIMEOUT_MS = 15_000;

export type OutcomeSyncDeps = {
  readonly project: string;
  readonly ledger: LedgerSyncPort;
  readonly token: string;
  // Read at run time so the job follows settings without a rebuild.
  readonly repos: () => readonly RepoName[];
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
};

const ghPull = z.object({
  number: z.number().int(),
  title: z.string(),
  html_url: z.string(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean().nullish(),
  body: z.string().nullish(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullish(),
  merged_at: z.string().nullish(),
  head: z.object({ ref: z.string() }),
});
type GhPull = z.infer<typeof ghPull>;

const ghRuns = z.object({
  workflow_runs: z.array(
    z.object({
      id: z.number().int(),
      run_number: z.number().int(),
      display_title: z.string().nullish(),
      name: z.string().nullish(),
      status: z.string().nullish(),
      conclusion: z.string().nullish(),
      created_at: z.string(),
      html_url: z.string(),
    }),
  ),
});

// The hour is the claim key, so each hour syncs once across restarts.
export const outcomeSyncKey = (now: Date) => now.toISOString().slice(0, 13);

function lifecycleOf(pr: GhPull): PullRequestLifecycle {
  if (pr.merged_at) return { state: "merged", mergedAt: pr.merged_at };
  if (pr.state === "closed") return { state: "closed", closedAt: pr.closed_at ?? pr.updated_at };
  return { state: "open", draft: pr.draft === true };
}

class GithubStatusError extends Error {
  constructor(readonly status: number, endpoint: string) {
    super(`GitHub answered ${status} for ${endpoint}`);
  }
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

type RunTarget = { readonly producer: (typeof PR_PRODUCERS)[number]; readonly before: string | null };

export function createOutcomeSyncJob({ project, ledger, token, repos, apiBaseUrl = "https://api.github.com", fetch: doFetch = fetch, timeoutMs = TIMEOUT_MS }: OutcomeSyncDeps): Job {
  const base = apiBaseUrl.replace(/\/+$/, "");

  async function get(path: string): Promise<unknown> {
    const endpoint = `GET ${path.split("?")[0]}`;
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "automation-server" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(`GitHub ${endpoint} failed: ${err instanceof Error && err.name === "TimeoutError" ? "timed out" : "network error"}`);
    }
    if (!res.ok) throw new GithubStatusError(res.status, endpoint);
    return res.json();
  }

  // Newest updated first. stoppedAt is the last page read when the cap ended the read before it reached `since`.
  async function fetchPulls(repo: RepoName, since: number, firstPage: number): Promise<{ pulls: GhPull[]; newest: string | null; stoppedAt: number | null }> {
    const pulls: GhPull[] = [];
    let newest: string | null = null;
    const lastPage = firstPage + MAX_PR_PAGES - 1;
    for (let page = firstPage; page <= lastPage; page++) {
      const items = z.array(ghPull).parse(await get(`/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${PAGE_SIZE}&page=${page}`));
      newest ??= items[0]?.updated_at ?? null;
      const fresh = items.filter((pr) => Date.parse(pr.updated_at) >= since);
      pulls.push(...fresh);
      if (items.length < PAGE_SIZE || fresh.length < items.length) return { pulls, newest, stoppedAt: null };
    }
    return { pulls, newest, stoppedAt: lastPage };
  }

  // Newest created first. A capped producer comes back in `remaining` with the oldest run it read, so the next read ends there.
  async function fetchRuns(repo: RepoName, since: number, targets: readonly RunTarget[]): Promise<{ runs: FetchedRun[]; remaining: RunResume["remaining"] }> {
    const from = new Date(since).toISOString().slice(0, 10);
    const runs: FetchedRun[] = [];
    const remaining: { producer: ProducerId; before: string }[] = [];
    for (const { producer, before } of targets) {
      const created = encodeURIComponent(before === null ? `>=${from}` : `${from}..${before}`);
      let oldest: string | null = null;
      for (let page = 1; page <= MAX_RUN_PAGES; page++) {
        let body: unknown;
        try {
          body = await get(`/repos/${repo}/actions/workflows/${producer.workflowFile}/runs?created=${created}&per_page=${PAGE_SIZE}&page=${page}`);
        } catch (err) {
          // The workflow is not installed in this repository.
          if (err instanceof GithubStatusError && err.status === 404) break;
          throw err;
        }
        const items = ghRuns.parse(body).workflow_runs;
        for (const r of items) {
          if (oldest === null || r.created_at < oldest) oldest = r.created_at;
          runs.push({
            repo,
            id: r.id,
            producer: producer.id,
            runNumber: r.run_number,
            title: r.display_title ?? r.name ?? producer.workflowFile,
            state: toWorkflowState(r.status, r.conclusion),
            createdAt: r.created_at,
            url: r.html_url,
          });
        }
        if (items.length < PAGE_SIZE) break;
        if (page === MAX_RUN_PAGES && oldest !== null) remaining.push({ producer: producer.id, before: oldest });
      }
    }
    return { runs, remaining };
  }

  async function syncRepo(repo: RepoName, now: Date): Promise<void> {
    const progress = ledger.syncState(project, repo);
    const backfill = now.getTime() - BACKFILL_DAYS * DAY_MS;

    const prSince = progress.prCursor ? Date.parse(progress.prCursor) - PR_OVERLAP_MS : backfill;
    const read = await fetchPulls(repo, prSince, progress.prResume?.page ?? 1);
    const newest = progress.prResume ? progress.prResume.newest : read.newest;
    const pullRequests: PullRequestRecord[] = [];
    const linkedByPr = new Map<number, WorkKey>();
    for (const pr of read.pulls) {
      const producer = producerOfBranch(pr.head.ref);
      if (!producer) continue;
      const key = workKeyFromPullRequest({ repo, headBranch: pr.head.ref, title: pr.title });
      pullRequests.push({ repo, number: pr.number, producer, workKey: key, title: pr.title, url: pr.html_url, createdAt: pr.created_at, lifecycle: lifecycleOf(pr) });
      const runId = workflowRunIdFromBody(repo, pr.body ?? "");
      if (key && runId !== null) linkedByPr.set(runId, key);
    }
    // The resumed read starts on the last page already read: a PR deleted meanwhile shifts the rest up by one, never past a page.
    const prProgress: Pick<SyncProgress, "prCursor" | "prResume"> =
      read.stoppedAt === null ? { prCursor: newest ?? progress.prCursor, prResume: null } : { prCursor: progress.prCursor, prResume: { page: read.stoppedAt, newest } };

    const runSince = progress.runCursor ? Math.max(backfill, Date.parse(progress.runCursor) - RUN_LOOKBACK_DAYS * DAY_MS) : backfill;
    const targets: RunTarget[] = progress.runResume
      ? progress.runResume.remaining.flatMap(({ producer: id, before }) => PR_PRODUCERS.filter((p) => p.id === id).map((producer) => ({ producer, before })))
      : PR_PRODUCERS.map((producer) => ({ producer, before: null }));
    let workflowRuns: WorkflowRunRecord[] = [];
    let runProgress: Pick<SyncProgress, "runCursor" | "runResume"> = { runCursor: progress.runCursor, runResume: progress.runResume };
    let error: string | null = null;
    try {
      const fetched = await fetchRuns(repo, runSince, targets);
      const ids = fetched.runs.map((r) => r.id);
      workflowRuns = linkRuns(fetched.runs, {
        repo,
        dispatched: ledger.dispatchedRuns(project, repo, ids),
        linkedByPr,
        previous: ledger.runLinks(project, repo, ids),
      });
      const startedAt = progress.runResume?.startedAt ?? now.toISOString();
      runProgress =
        fetched.remaining.length === 0 ? { runCursor: startedAt, runResume: null } : { runCursor: progress.runCursor, runResume: { startedAt, remaining: fetched.remaining } };
    } catch (err) {
      error = `Workflow runs not read: ${messageOf(err)}`;
    }
    ledger.applyRepoSync({ project, repo, pullRequests, workflowRuns, progress: { ...prProgress, ...runProgress }, syncedAt: now.toISOString(), error });
  }

  return {
    name: OUTCOME_SYNC_JOB,
    project,
    due: outcomeSyncKey,
    async run({ log, now }) {
      const targets = repos();
      const failures: string[] = [];
      for (const repo of targets) {
        try {
          await syncRepo(repo, now);
        } catch (err) {
          const message = messageOf(err);
          failures.push(`${repo}: ${message}`);
          recordFailure(log, repo, message, now);
        }
      }
      log.info("outcome sync finished", { repos: targets.length, failed: failures.length });
      // One repository's error shows on the Outcomes page. Only a total failure marks the run failed.
      if (targets.length > 0 && failures.length === targets.length) throw new Error(`outcome sync failed for every repository: ${failures.join("; ")}`);
    },
  };

  function recordFailure(log: Logger, repo: RepoName, message: string, now: Date) {
    log.warn("outcome sync failed for a repository", { repo, error: message });
    try {
      ledger.recordSyncError(project, repo, message, now.toISOString());
    } catch (err) {
      log.error("recording the outcome sync error failed", { repo, error: messageOf(err) });
    }
  }
}

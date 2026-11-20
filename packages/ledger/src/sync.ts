import type { Job, Logger } from "@automation-server/core";
import { z } from "zod";

import { linkRuns, type FetchedRun } from "./match";
import { DAY_MS } from "./metrics";
import type { LedgerSyncPort } from "./ports";
import { PR_PRODUCERS, producerOfBranch } from "./producers";
import type { PullRequestLifecycle, PullRequestRecord, RepoName, WorkKey } from "./types";
import { toWorkflowState } from "./workflowState";
import { workflowRunIdFromBody, workKeyFromPullRequest } from "./workKey";

export const OUTCOME_SYNC_JOB = "outcome-sync";

// The first sync reaches as far back as the longest metric window.
const BACKFILL_DAYS = 90;
// Workflow runs finish within 30 minutes, so later syncs re-read two days to catch late states.
const RUN_LOOKBACK_DAYS = 2;
const PR_OVERLAP_MS = 60 * 60_000;
const PAGE_SIZE = 100;
const MAX_PR_PAGES = 10;
const MAX_RUN_PAGES = 3;

export type OutcomeSyncDeps = {
  readonly project: string;
  readonly ledger: LedgerSyncPort;
  readonly token: string;
  // Read at run time so the job follows settings without a rebuild.
  readonly repos: () => readonly RepoName[];
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof fetch;
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

export function createOutcomeSyncJob({ project, ledger, token, repos, apiBaseUrl = "https://api.github.com", fetch: doFetch = fetch }: OutcomeSyncDeps): Job {
  const base = apiBaseUrl.replace(/\/+$/, "");

  async function get(path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "automation-server" },
      });
    } catch {
      throw new Error(`GitHub GET ${path.split("?")[0]} failed: network error`);
    }
    if (!res.ok) throw new GithubStatusError(res.status, `GET ${path.split("?")[0]}`);
    return res.json();
  }

  async function fetchPulls(repo: RepoName, since: number): Promise<{ pulls: GhPull[]; newest: string | null }> {
    const pulls: GhPull[] = [];
    let newest: string | null = null;
    for (let page = 1; page <= MAX_PR_PAGES; page++) {
      const items = z.array(ghPull).parse(await get(`/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${PAGE_SIZE}&page=${page}`));
      newest ??= items[0]?.updated_at ?? null;
      const fresh = items.filter((pr) => Date.parse(pr.updated_at) >= since);
      pulls.push(...fresh);
      if (items.length < PAGE_SIZE || fresh.length < items.length) break;
    }
    return { pulls, newest };
  }

  async function fetchRuns(repo: RepoName, since: number): Promise<FetchedRun[]> {
    const created = new Date(since).toISOString().slice(0, 10);
    const runs: FetchedRun[] = [];
    for (const producer of PR_PRODUCERS) {
      for (let page = 1; page <= MAX_RUN_PAGES; page++) {
        let body: unknown;
        try {
          body = await get(`/repos/${repo}/actions/workflows/${producer.workflowFile}/runs?created=%3E%3D${created}&per_page=${PAGE_SIZE}&page=${page}`);
        } catch (err) {
          // The workflow is not installed in this repository.
          if (err instanceof GithubStatusError && err.status === 404) break;
          throw err;
        }
        const items = ghRuns.parse(body).workflow_runs;
        for (const r of items) {
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
      }
    }
    return runs;
  }

  async function syncRepo(repo: RepoName, now: Date): Promise<void> {
    const state = ledger.syncState(project, repo);
    const backfill = now.getTime() - BACKFILL_DAYS * DAY_MS;
    const prSince = state.prCursor ? Date.parse(state.prCursor) - PR_OVERLAP_MS : backfill;
    const runSince = state.prCursor ? now.getTime() - RUN_LOOKBACK_DAYS * DAY_MS : backfill;

    const { pulls, newest } = await fetchPulls(repo, prSince);
    const pullRequests: PullRequestRecord[] = [];
    const linkedByPr = new Map<number, WorkKey>();
    for (const pr of pulls) {
      const producer = producerOfBranch(pr.head.ref);
      if (!producer) continue;
      const body = pr.body ?? "";
      const key = workKeyFromPullRequest({ repo, headBranch: pr.head.ref, title: pr.title, body });
      pullRequests.push({ repo, number: pr.number, producer, workKey: key, title: pr.title, url: pr.html_url, createdAt: pr.created_at, lifecycle: lifecycleOf(pr) });
      const runId = workflowRunIdFromBody(repo, body);
      if (key && runId !== null) linkedByPr.set(runId, key);
    }

    const fetched = await fetchRuns(repo, runSince);
    const ids = fetched.map((r) => r.id);
    const workflowRuns = linkRuns(fetched, {
      repo,
      dispatched: ledger.dispatchedRuns(project, repo, ids),
      linkedByPr,
      previous: ledger.runLinks(project, repo, ids),
    });
    ledger.applyRepoSync({ project, repo, pullRequests, workflowRuns, prCursor: newest, syncedAt: now.toISOString() });
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
          const message = err instanceof Error ? err.message : String(err);
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
      log.error("recording the outcome sync error failed", { repo, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

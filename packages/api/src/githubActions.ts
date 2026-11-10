import { z } from "zod";

export const ACTION_STATES = ["queued", "waiting", "running", "success", "failure", "cancelled", "skipped"] as const;
export type ActionState = (typeof ACTION_STATES)[number];

export type WorkflowRun = {
  readonly id: number;
  readonly repo: string;
  readonly workflow: string;
  readonly title: string;
  readonly runNumber: number;
  readonly attempt: number;
  readonly event: string;
  readonly branch: string | null;
  readonly sha: string;
  readonly actor: { readonly login: string; readonly avatarUrl: string } | null;
  readonly state: ActionState;
  readonly conclusion: string | null;
  readonly createdAt: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly url: string;
};

export type WorkflowStep = {
  readonly number: number;
  readonly name: string;
  readonly state: ActionState;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
};

export type WorkflowJob = {
  readonly id: number;
  readonly name: string;
  readonly state: ActionState;
  readonly conclusion: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly url: string | null;
  readonly runner: string | null;
  readonly steps: WorkflowStep[];
};

export type RepoError = { readonly repo: string; readonly message: string };

export type ActionsRunList = {
  readonly repos: string[];
  readonly workflows: string[];
  readonly runs: WorkflowRun[];
  readonly errors: RepoError[];
  readonly nextPage: number | null;
};

export type ActionsRunQuery = { repo?: string; workflow?: string; state?: ActionState; page: number };

export type ActionsReader = {
  readonly repos: string[];
  listRuns(query: ActionsRunQuery): Promise<ActionsRunList>;
  getRun(repo: string, id: number): Promise<{ run: WorkflowRun; jobs: WorkflowJob[] } | null>;
};

export const isActive = (state: ActionState) => state === "queued" || state === "waiting" || state === "running";

// GitHub splits a run's lifecycle into `status` and, once completed, `conclusion`. The admin needs one value.
export function toState(status: string | null | undefined, conclusion: string | null | undefined): ActionState {
  if (status !== "completed") {
    if (status === "in_progress") return "running";
    if (status === "waiting") return "waiting";
    return "queued";
  }
  switch (conclusion) {
    case "success":
    case "neutral":
      return "success";
    case "cancelled":
      return "cancelled";
    case "skipped":
    case "stale":
      return "skipped";
    case "action_required":
      return "waiting";
    default:
      return "failure";
  }
}

// The `status` query parameter of the runs endpoint accepts both statuses and conclusions.
const STATE_FILTER: Record<ActionState, string> = {
  queued: "queued",
  waiting: "waiting",
  running: "in_progress",
  success: "success",
  failure: "failure",
  cancelled: "cancelled",
  skipped: "skipped",
};

const ghRun = z.object({
  id: z.number(),
  name: z.string().nullish(),
  display_title: z.string().nullish(),
  run_number: z.number(),
  run_attempt: z.number().nullish(),
  event: z.string(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  head_branch: z.string().nullish(),
  head_sha: z.string(),
  html_url: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  run_started_at: z.string().nullish(),
  actor: z.object({ login: z.string(), avatar_url: z.string() }).nullish(),
});
const ghRunList = z.object({ workflow_runs: z.array(ghRun) });
const ghWorkflowList = z.object({ workflows: z.array(z.object({ id: z.number(), name: z.string() })) });
const ghStep = z.object({
  number: z.number(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullish(),
  started_at: z.string().nullish(),
  completed_at: z.string().nullish(),
});
const ghJobList = z.object({
  jobs: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullish(),
      started_at: z.string().nullish(),
      completed_at: z.string().nullish(),
      html_url: z.string().nullish(),
      runner_name: z.string().nullish(),
      steps: z.array(ghStep).nullish(),
    }),
  ),
});
const ghError = z.object({ message: z.string().optional() });

const toRun = (repo: string, r: z.infer<typeof ghRun>): WorkflowRun => ({
  id: r.id,
  repo,
  workflow: r.name ?? "workflow",
  title: r.display_title ?? r.name ?? `Run ${r.run_number}`,
  runNumber: r.run_number,
  attempt: r.run_attempt ?? 1,
  event: r.event,
  branch: r.head_branch ?? null,
  sha: r.head_sha,
  actor: r.actor ? { login: r.actor.login, avatarUrl: r.actor.avatar_url } : null,
  state: toState(r.status, r.conclusion),
  conclusion: r.conclusion ?? null,
  createdAt: r.created_at,
  startedAt: r.run_started_at ?? r.created_at,
  updatedAt: r.updated_at,
  url: r.html_url,
});

export class GithubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type GithubActionsReaderConfig = {
  repos: string[];
  token: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  cacheMs?: number;
  workflowsCacheMs?: number;
  perPage?: number;
  now?: () => number;
};

export function createGithubActionsReader(config: GithubActionsReaderConfig): ActionsReader {
  const base = (config.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const doFetch = config.fetch ?? fetch;
  const now = config.now ?? Date.now;
  const cacheMs = config.cacheMs ?? 4_000;
  const workflowsCacheMs = config.workflowsCacheMs ?? 300_000;
  const perPage = config.perPage ?? 25;
  const repos = [...config.repos];
  // Several admin tabs polling the same page share one GitHub request, which keeps the token well inside its rate limit.
  const cache = new Map<string, { at: number; ttl: number; value: Promise<unknown> }>();

  async function fetchJson(path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        headers: {
          Authorization: `Bearer ${config.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "automation-server",
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new GithubApiError("GitHub API is unreachable", 0);
    }
    if (res.ok) return res.json();
    if (res.status === 404) throw new GithubApiError("Not found, or the token cannot see this repository", 404);
    if (res.status === 403 || res.status === 429) {
      if (res.headers.get("x-ratelimit-remaining") === "0") {
        throw new GithubApiError("GitHub API rate limit reached, retrying shortly", res.status);
      }
      throw new GithubApiError("The token lacks Actions: Read on this repository", res.status);
    }
    if (res.status === 401) throw new GithubApiError("GitHub rejected the token", 401);
    const parsed = ghError.safeParse(await res.json().catch(() => null));
    const detail = parsed.success && parsed.data.message ? `: ${parsed.data.message.slice(0, 200)}` : "";
    throw new GithubApiError(`GitHub API answered ${res.status}${detail}`, res.status);
  }

  function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && now() - hit.at < hit.ttl) return hit.value as Promise<T>;
    const value = load();
    cache.set(key, { at: now(), ttl, value });
    value.catch(() => cache.delete(key));
    if (cache.size > 500) {
      for (const [k, v] of cache) if (now() - v.at >= v.ttl) cache.delete(k);
    }
    return value;
  }

  const workflowsOf = (repo: string) =>
    cached(`workflows:${repo}`, workflowsCacheMs, async () =>
      ghWorkflowList.parse(await fetchJson(`/repos/${repo}/actions/workflows?per_page=100`)).workflows,
    );

  async function runsOf(repo: string, query: ActionsRunQuery): Promise<WorkflowRun[] | null> {
    let path = `/repos/${repo}/actions/runs`;
    if (query.workflow) {
      const workflow = (await workflowsOf(repo)).find((w) => w.name === query.workflow);
      if (!workflow) return null;
      path = `/repos/${repo}/actions/workflows/${workflow.id}/runs`;
    }
    const params = new URLSearchParams({ per_page: String(perPage), page: String(query.page) });
    if (query.state) params.set("status", STATE_FILTER[query.state]);
    const url = `${path}?${params}`;
    return cached(`runs:${url}`, cacheMs, async () =>
      ghRunList.parse(await fetchJson(url)).workflow_runs.map((r) => toRun(repo, r)),
    );
  }

  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

  return {
    repos,

    async listRuns(query) {
      const targets = query.repo ? repos.filter((r) => r === query.repo) : repos;
      const errors: RepoError[] = [];
      const workflowNames = new Set<string>();
      let full = false;

      const runs = (
        await Promise.all(
          targets.map(async (repo) => {
            try {
              const [workflows, found] = await Promise.all([workflowsOf(repo), runsOf(repo, query)]);
              for (const w of workflows) workflowNames.add(w.name);
              if (found && found.length === perPage) full = true;
              return found ?? [];
            } catch (err) {
              errors.push({ repo, message: message(err) });
              return [];
            }
          }),
        )
      )
        .flat()
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

      return {
        repos,
        workflows: [...workflowNames].sort((a, b) => a.localeCompare(b)),
        runs,
        errors,
        nextPage: full ? query.page + 1 : null,
      };
    },

    async getRun(repo, id) {
      if (!repos.includes(repo)) return null;
      try {
        const [run, jobs] = await Promise.all([
          cached(`run:${repo}:${id}`, cacheMs, async () => toRun(repo, ghRun.parse(await fetchJson(`/repos/${repo}/actions/runs/${id}`)))),
          cached(`jobs:${repo}:${id}`, cacheMs, async () =>
            ghJobList.parse(await fetchJson(`/repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=100`)).jobs,
          ),
        ]);
        return {
          run,
          jobs: jobs.map((j) => ({
            id: j.id,
            name: j.name,
            state: toState(j.status, j.conclusion),
            conclusion: j.conclusion ?? null,
            startedAt: j.started_at ?? null,
            completedAt: j.completed_at ?? null,
            url: j.html_url ?? null,
            runner: j.runner_name ?? null,
            steps: (j.steps ?? []).map((s) => ({
              number: s.number,
              name: s.name,
              state: toState(s.status, s.conclusion),
              startedAt: s.started_at ?? null,
              completedAt: s.completed_at ?? null,
            })),
          })),
        };
      } catch (err) {
        if (err instanceof GithubApiError && err.status === 404) return null;
        throw err;
      }
    },
  };
}

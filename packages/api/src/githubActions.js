import { z } from "zod";
import { errorMessage } from "./errors";
import { GITHUB_API, githubErrorDetail, githubHeaders } from "./githubApi";
export const ACTION_STATES = ["queued", "waiting", "running", "success", "failure", "cancelled", "skipped"];
// GitHub splits a run's lifecycle into `status` and, once completed, `conclusion`. The admin needs one value.
export function toState(status, conclusion) {
    if (status !== "completed") {
        if (status === "in_progress")
            return "running";
        if (status === "waiting")
            return "waiting";
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
const STATE_FILTER = {
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
    jobs: z.array(z.object({
        id: z.number(),
        name: z.string(),
        status: z.string(),
        conclusion: z.string().nullish(),
        started_at: z.string().nullish(),
        completed_at: z.string().nullish(),
        html_url: z.string().nullish(),
        runner_name: z.string().nullish(),
        steps: z.array(ghStep).nullish(),
    })),
});
const toRun = (repo, r) => ({
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
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}
export function createGithubActionsReader(config) {
    const base = (config.apiBaseUrl ?? GITHUB_API).replace(/\/+$/, "");
    const doFetch = config.fetch ?? fetch;
    const now = config.now ?? Date.now;
    const cacheMs = config.cacheMs ?? 4_000;
    const workflowsCacheMs = config.workflowsCacheMs ?? 300_000;
    const perPage = config.perPage ?? 25;
    const repos = [...config.repos];
    // Several admin tabs polling the same page share one GitHub request, which keeps the token well inside its rate limit.
    const cache = new Map();
    async function fetchJson(path) {
        let res;
        try {
            res = await doFetch(`${base}${path}`, {
                headers: githubHeaders(config.token),
                signal: AbortSignal.timeout(10_000),
            });
        }
        catch {
            throw new GithubApiError("GitHub API is unreachable", 0);
        }
        if (res.ok)
            return res.json();
        if (res.status === 404)
            throw new GithubApiError("Not found, or the token cannot see this repository", 404);
        if (res.status === 403 || res.status === 429) {
            if (res.headers.get("x-ratelimit-remaining") === "0") {
                throw new GithubApiError("GitHub API rate limit reached, retrying shortly", res.status);
            }
            throw new GithubApiError("The token lacks Actions: Read on this repository", res.status);
        }
        if (res.status === 401)
            throw new GithubApiError("GitHub rejected the token", 401);
        const detail = await githubErrorDetail(res);
        throw new GithubApiError(`GitHub API answered ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
    }
    function cached(key, ttl, load) {
        const hit = cache.get(key);
        if (hit && now() - hit.at < hit.ttl)
            return hit.value;
        const value = load();
        cache.set(key, { at: now(), ttl, value });
        value.catch(() => {
            if (cache.get(key)?.value === value)
                cache.delete(key);
        });
        if (cache.size > 500) {
            for (const [k, v] of cache)
                if (now() - v.at >= v.ttl)
                    cache.delete(k);
        }
        return value;
    }
    const workflowsOf = (repo) => cached(`workflows:${repo}`, workflowsCacheMs, async () => ghWorkflowList.parse(await fetchJson(`/repos/${repo}/actions/workflows?per_page=100`)).workflows);
    async function runsOf(repo, query) {
        let path = `/repos/${repo}/actions/runs`;
        if (query.workflow) {
            const workflow = (await workflowsOf(repo)).find((w) => w.name === query.workflow);
            if (!workflow)
                return null;
            path = `/repos/${repo}/actions/workflows/${workflow.id}/runs`;
        }
        const params = new URLSearchParams({ per_page: String(perPage), page: String(query.page) });
        if (query.state)
            params.set("status", STATE_FILTER[query.state]);
        const url = `${path}?${params}`;
        return cached(`runs:${url}`, cacheMs, async () => ghRunList.parse(await fetchJson(url)).workflow_runs.map((r) => toRun(repo, r)));
    }
    return {
        repos,
        async listRuns(query) {
            const targets = query.repo ? repos.filter((r) => r === query.repo) : repos;
            const errors = [];
            const workflowNames = new Set();
            let full = false;
            const runs = (await Promise.all(targets.map(async (repo) => {
                try {
                    const [workflows, found] = await Promise.all([workflowsOf(repo), runsOf(repo, query)]);
                    for (const w of workflows)
                        workflowNames.add(w.name);
                    if (found && found.length === perPage)
                        full = true;
                    return found ?? [];
                }
                catch (err) {
                    errors.push({ repo, message: errorMessage(err) });
                    return [];
                }
            })))
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
            if (!repos.includes(repo))
                return null;
            try {
                const [run, jobs] = await Promise.all([
                    cached(`run:${repo}:${id}`, cacheMs, async () => toRun(repo, ghRun.parse(await fetchJson(`/repos/${repo}/actions/runs/${id}`)))),
                    cached(`jobs:${repo}:${id}`, cacheMs, async () => ghJobList.parse(await fetchJson(`/repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=100`)).jobs),
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
            }
            catch (err) {
                if (err instanceof GithubApiError && err.status === 404)
                    return null;
                throw err;
            }
        },
    };
}

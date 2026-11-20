import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { checkWorkflow, getActionRun, listProjects, getOverview, getRun, getSettings, getSlackDirectory, getCrispStats, getSystem, getWorkflowStatus, listActionRuns, listCrisp, listLogs, listRuns, listWorkflowTemplates, } from "./api.functions";
export const retryServerErrorOnce = (count, error) => count < 1 && error instanceof Error && error.message === "SERVER_ERROR";
export const projectsQuery = () => queryOptions({
    queryKey: ["projects"],
    queryFn: () => listProjects(),
});
// Every project-scoped key starts with the project, so switching projects never shows another project's data.
export const overviewQuery = (project, window) => queryOptions({
    queryKey: [project, "overview", window],
    queryFn: () => getOverview({ data: { project, window } }),
});
export const logsQuery = (project, filters, live) => infiniteQueryOptions({
    queryKey: [project, "logs", filters],
    queryFn: ({ pageParam }) => listLogs({ data: { ...filters, project, before: pageParam, limit: 50 } }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: live ? 5000 : false,
});
export const runsQuery = (project, filters) => infiniteQueryOptions({
    queryKey: [project, "runs", filters],
    queryFn: ({ pageParam }) => listRuns({ data: { ...filters, project, before: pageParam, limit: 50 } }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
});
const CRISP_POLL_MS = 10_000;
const RUN_POLL_MS = 2000;
export const crispQuery = (project, filters) => infiniteQueryOptions({
    queryKey: [...crispKey(project), filters],
    queryFn: ({ pageParam }) => listCrisp({ data: { ...filters, project, before: pageParam, limit: 30 } }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: CRISP_POLL_MS,
});
export const crispStatsQuery = (project) => queryOptions({
    queryKey: crispStatsKey(project),
    queryFn: () => getCrispStats({ data: { project } }),
    refetchInterval: CRISP_POLL_MS,
});
export const runQuery = (project, id) => queryOptions({
    queryKey: [project, "run", id],
    queryFn: () => getRun({ data: { project, id } }),
    refetchInterval: (query) => (query.state.data?.run.status === "running" ? RUN_POLL_MS : false),
});
export const systemQuery = (project) => queryOptions({
    queryKey: [project, "system"],
    queryFn: () => getSystem({ data: { project } }),
});
export const isActiveState = (state) => state === "queued" || state === "waiting" || state === "running";
// Poll fast while something is moving so a run's progress shows up within seconds, slowly otherwise.
const ACTIVE_POLL_MS = 5_000;
const IDLE_POLL_MS = 30_000;
export const actionRunsQuery = (project, filters) => infiniteQueryOptions({
    queryKey: [project, "actions", filters],
    queryFn: ({ pageParam }) => listActionRuns({ data: { ...filters, project, page: pageParam } }),
    initialPageParam: 1,
    getNextPageParam: (page) => page.nextPage ?? undefined,
    refetchInterval: (query) => query.state.data?.pages.some((p) => p.runs.some((r) => isActiveState(r.state))) ? ACTIVE_POLL_MS : IDLE_POLL_MS,
});
export const actionRunQuery = (project, repo, id) => queryOptions({
    queryKey: [project, "action", repo, id],
    queryFn: () => getActionRun({ data: { project, repo, id } }),
    refetchInterval: (query) => (query.state.data && isActiveState(query.state.data.run.state) ? ACTIVE_POLL_MS : false),
});
export const settingsQuery = (project) => queryOptions({
    queryKey: [project, "settings"],
    queryFn: () => getSettings({ data: { project } }),
});
const DIRECTORY_STALE_MS = 30_000;
export const slackDirectoryKey = (project, kind) => [project, "slack-directory", kind];
// The server caches the Slack lists for a minute, so a short client cache only saves the round trip.
export const slackDirectoryQuery = (project, kind, search) => queryOptions({
    queryKey: [...slackDirectoryKey(project, kind), search],
    queryFn: () => getSlackDirectory({ data: { project, kind, ...(search ? { search } : {}) } }),
    staleTime: DIRECTORY_STALE_MS,
    retry: false,
});
export const workflowTemplatesQuery = () => queryOptions({
    queryKey: ["workflow-templates"],
    queryFn: () => listWorkflowTemplates(),
    staleTime: Infinity,
});
export const workflowStatusKey = (project, repo) => [project, "workflow-status", repo];
export const workflowCheckKey = (project, repo) => [project, "workflow-check", repo];
export const crispKey = (project) => [project, "crisp"];
export const crispStatsKey = (project) => [project, "crisp-stats"];
export const workflowStatusQuery = (project, repo) => queryOptions({
    queryKey: workflowStatusKey(project, repo),
    queryFn: () => getWorkflowStatus({ data: { project, repo } }),
});
export const workflowCheckQuery = (project, repo, templateId) => queryOptions({
    queryKey: [...workflowCheckKey(project, repo), templateId],
    queryFn: () => checkWorkflow({ data: { project, repo, templateId } }),
    retry: false,
});

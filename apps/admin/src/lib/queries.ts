import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query"

import {
  getActionRun,
  listProjects,
  getOverview,
  getRun,
  getSettings,
  getSystem,
  getWorkflowStatus,
  listActionRuns,
  listLogs,
  listRuns,
  listWorkflowTemplates,
} from "./api.functions"
import type { ActionState, ActionsSearch, LogsSearch, RunsSearch, WindowKey } from "./filters"

const retryServerErrorOnce = (count: number, error: unknown) =>
  count < 1 && error instanceof Error && error.message === "SERVER_ERROR"

export const projectsQuery = () =>
  queryOptions({
    queryKey: ["projects"],
    queryFn: () => listProjects(),
    retry: retryServerErrorOnce,
  })

// Every project-scoped key starts with the project, so switching projects never shows another project's data.

export const overviewQuery = (project: string, window: WindowKey) =>
  queryOptions({
    queryKey: [project, "overview", window],
    queryFn: () => getOverview({ data: { project, window } }),
    retry: retryServerErrorOnce,
  })

export const logsQuery = (project: string, filters: LogsSearch, live: boolean) =>
  infiniteQueryOptions({
    queryKey: [project, "logs", filters],
    queryFn: ({ pageParam }) => listLogs({ data: { ...filters, project, before: pageParam, limit: 50 } }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: live ? 5000 : false,
    retry: retryServerErrorOnce,
  })

export const runsQuery = (project: string, filters: RunsSearch) =>
  infiniteQueryOptions({
    queryKey: [project, "runs", filters],
    queryFn: ({ pageParam }) => listRuns({ data: { ...filters, project, before: pageParam, limit: 50 } }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: retryServerErrorOnce,
  })

export const runQuery = (project: string, id: string) =>
  queryOptions({
    queryKey: [project, "run", id],
    queryFn: () => getRun({ data: { project, id } }),
    retry: retryServerErrorOnce,
  })

export const systemQuery = (project: string) =>
  queryOptions({
    queryKey: [project, "system"],
    queryFn: () => getSystem({ data: { project } }),
    retry: retryServerErrorOnce,
  })

export const isActiveState = (state: ActionState) => state === "queued" || state === "waiting" || state === "running"

// Poll fast while something is moving so a run's progress shows up within seconds, slowly otherwise.
const ACTIVE_POLL_MS = 5_000
const IDLE_POLL_MS = 30_000

export const actionRunsQuery = (project: string, filters: ActionsSearch) =>
  infiniteQueryOptions({
    queryKey: [project, "actions", filters],
    queryFn: ({ pageParam }) => listActionRuns({ data: { ...filters, project, page: pageParam } }),
    initialPageParam: 1,
    getNextPageParam: (page) => page.nextPage ?? undefined,
    refetchInterval: (query) =>
      query.state.data?.pages.some((p) => p.runs.some((r) => isActiveState(r.state))) ? ACTIVE_POLL_MS : IDLE_POLL_MS,
    retry: retryServerErrorOnce,
  })

export const actionRunQuery = (project: string, repo: string, id: number) =>
  queryOptions({
    queryKey: [project, "action", repo, id],
    queryFn: () => getActionRun({ data: { project, repo, id } }),
    refetchInterval: (query) => (query.state.data && isActiveState(query.state.data.run.state) ? ACTIVE_POLL_MS : false),
    retry: retryServerErrorOnce,
  })

export const settingsQuery = (project: string) =>
  queryOptions({
    queryKey: [project, "settings"],
    queryFn: () => getSettings({ data: { project } }),
    retry: retryServerErrorOnce,
  })

export const workflowTemplatesQuery = () =>
  queryOptions({
    queryKey: ["workflow-templates"],
    queryFn: () => listWorkflowTemplates(),
    staleTime: Infinity,
    retry: retryServerErrorOnce,
  })

export const workflowStatusQuery = (project: string, repo: string) =>
  queryOptions({
    queryKey: [project, "workflow-status", repo],
    queryFn: () => getWorkflowStatus({ data: { project, repo } }),
    retry: retryServerErrorOnce,
  })

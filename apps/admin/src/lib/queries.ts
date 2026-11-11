import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query"

import {
  getActionRun,
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

export const overviewQuery = (window: WindowKey) =>
  queryOptions({
    queryKey: ["overview", window],
    queryFn: () => getOverview({ data: { window } }),
    retry: retryServerErrorOnce,
  })

export const logsQuery = (filters: LogsSearch, live: boolean) =>
  infiniteQueryOptions({
    queryKey: ["logs", filters],
    queryFn: ({ pageParam }) => listLogs({ data: { ...filters, before: pageParam, limit: 50 } }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: live ? 5000 : false,
    retry: retryServerErrorOnce,
  })

export const runsQuery = (filters: RunsSearch) =>
  infiniteQueryOptions({
    queryKey: ["runs", filters],
    queryFn: ({ pageParam }) => listRuns({ data: { ...filters, before: pageParam, limit: 50 } }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: retryServerErrorOnce,
  })

export const runQuery = (id: string) =>
  queryOptions({
    queryKey: ["run", id],
    queryFn: () => getRun({ data: { id } }),
    retry: retryServerErrorOnce,
  })

export const systemQuery = () =>
  queryOptions({
    queryKey: ["system"],
    queryFn: () => getSystem(),
    retry: retryServerErrorOnce,
  })

export const isActiveState = (state: ActionState) => state === "queued" || state === "waiting" || state === "running"

// Poll fast while something is moving so a run's progress shows up within seconds, slowly otherwise.
const ACTIVE_POLL_MS = 5_000
const IDLE_POLL_MS = 30_000

export const actionRunsQuery = (filters: ActionsSearch) =>
  infiniteQueryOptions({
    queryKey: ["actions", filters],
    queryFn: ({ pageParam }) => listActionRuns({ data: { ...filters, page: pageParam } }),
    initialPageParam: 1,
    getNextPageParam: (page) => page.nextPage ?? undefined,
    refetchInterval: (query) =>
      query.state.data?.pages.some((p) => p.runs.some((r) => isActiveState(r.state))) ? ACTIVE_POLL_MS : IDLE_POLL_MS,
    retry: retryServerErrorOnce,
  })

export const actionRunQuery = (repo: string, id: number) =>
  queryOptions({
    queryKey: ["action", repo, id],
    queryFn: () => getActionRun({ data: { repo, id } }),
    refetchInterval: (query) => (query.state.data && isActiveState(query.state.data.run.state) ? ACTIVE_POLL_MS : false),
    retry: retryServerErrorOnce,
  })

export const settingsQuery = () =>
  queryOptions({
    queryKey: ["settings"],
    queryFn: () => getSettings(),
    retry: retryServerErrorOnce,
  })

export const workflowTemplatesQuery = () =>
  queryOptions({
    queryKey: ["workflow-templates"],
    queryFn: () => listWorkflowTemplates(),
    staleTime: Infinity,
    retry: retryServerErrorOnce,
  })

export const workflowStatusQuery = (repo: string) =>
  queryOptions({
    queryKey: ["workflow-status", repo],
    queryFn: () => getWorkflowStatus({ data: { repo } }),
    retry: retryServerErrorOnce,
  })

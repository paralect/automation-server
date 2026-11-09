import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query"

import { getOverview, getRun, getSystem, listLogs, listRuns } from "./api.functions"
import type { LogsSearch, RunsSearch, WindowKey } from "./filters"

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

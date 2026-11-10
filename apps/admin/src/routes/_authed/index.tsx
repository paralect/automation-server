import { useState } from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"

import { StatusBadge } from "@/components/badges"
import { EmptyState, PageHeader, QueryError } from "@/components/states"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Time } from "@/components/time"
import { WINDOWS, type WindowKey } from "@/lib/filters"
import { overviewQuery } from "@/lib/queries"

export const Route = createFileRoute("/_authed/")({ component: Overview })

const chartConfig = {
  succeeded: { label: "Succeeded", color: "var(--chart-2)" },
  failed: { label: "Failed", color: "var(--destructive)" },
  duplicate: { label: "Duplicate", color: "var(--chart-1)" },
} satisfies ChartConfig

const STATS = [
  { label: "Succeeded", pick: (s: Stats) => s.runs.succeeded },
  { label: "Failed", pick: (s: Stats) => s.runs.failed },
  { label: "Duplicate", pick: (s: Stats) => s.runs.duplicate },
  { label: "Running", pick: (s: Stats) => s.runs.running },
  { label: "Error logs", pick: (s: Stats) => s.logs.error },
]

type Stats = NonNullable<ReturnType<typeof useOverview>["data"]>

const useOverview = (window: WindowKey) => useQuery(overviewQuery(window))

function Overview() {
  const [window, setWindow] = useState<WindowKey>("24h")
  const { data, error, refetch } = useOverview(window)

  const tick = (iso: string) => {
    const date = new Date(iso)
    return window === "24h"
      ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
      : date.toLocaleString(undefined, { weekday: "short", hour: "2-digit" })
  }

  return (
    <>
      <PageHeader title="Overview" description="What the automation server did recently.">
        <ToggleGroup
          value={[window]}
          onValueChange={(next) => next[0] && setWindow(next[0] as WindowKey)}
          variant="outline"
          aria-label="Time window"
        >
          {(Object.keys(WINDOWS) as WindowKey[]).map((key) => (
            <ToggleGroupItem key={key} value={key}>
              Last {key}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </PageHeader>

      {error ? (
        <QueryError error={error} onRetry={() => refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
            {STATS.map((stat) => (
              <Card key={stat.label} size="sm">
                <CardHeader>
                  <CardDescription>{stat.label}</CardDescription>
                  {!data ? (
                    <Skeleton className="h-8 w-16" />
                  ) : (
                    <CardTitle className="text-2xl tabular-nums">{stat.pick(data)}</CardTitle>
                  )}
                </CardHeader>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Runs over time</CardTitle>
              <CardDescription>
                {window === "24h" ? "Hourly" : "Six-hour"} buckets, local time
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!data ? (
                <Skeleton className="h-64 w-full" />
              ) : data.buckets.every((b) => b.succeeded + b.failed + b.duplicate === 0) ? (
                <EmptyState title="No runs in this window" hint="Runs appear here once a webhook triggers an automation." />
              ) : (
                <ChartContainer config={chartConfig} className="h-64 w-full">
                  <BarChart data={data.buckets} accessibilityLayer>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="start" tickFormatter={tick} tickLine={false} axisLine={false} minTickGap={24} />
                    <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={28} />
                    <ChartTooltip
                      content={<ChartTooltipContent labelFormatter={(_, p) => new Date(p[0]?.payload.start).toLocaleString()} />}
                    />
                    <ChartLegend content={<ChartLegendContent />} />
                    <Bar isAnimationActive={false} dataKey="succeeded" stackId="runs" fill="var(--color-succeeded)" />
                    <Bar isAnimationActive={false} dataKey="duplicate" stackId="runs" fill="var(--color-duplicate)" />
                    <Bar isAnimationActive={false} dataKey="failed" stackId="runs" fill="var(--color-failed)" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ChartContainer>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent failures</CardTitle>
            </CardHeader>
            <CardContent>
              {!data ? (
                <Skeleton className="h-24 w-full" />
              ) : data.recentFailures.length === 0 ? (
                <EmptyState title="No failures" hint="Nothing has failed in this window." />
              ) : (
                <ul className="divide-y">
                  {data.recentFailures.map((run) => (
                    <li key={run.id}>
                      <Link
                        to="/runs/$id"
                        params={{ id: run.id }}
                        className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md px-1 py-3 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        <StatusBadge status={run.status} />
                        <span className="text-sm font-medium">{run.automation}</span>
                        <span className="text-xs text-muted-foreground">{run.source}</span>
                        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                          {run.error}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          <Time iso={run.startedAt} relativeOnly />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </>
  )
}

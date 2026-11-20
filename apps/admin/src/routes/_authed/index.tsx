import { useState } from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { CaretRightIcon, ListChecksIcon } from "@phosphor-icons/react"
import { cn } from "cn"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"

import { StatusBadge } from "@/components/badges"
import { EmptyState, PageHeader, QueryError } from "@/components/states"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
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
import { WINDOW_KEYS, type WindowKey } from "@/lib/filters"
import { BUDGET_FILL } from "@/lib/badge-styles"
import { budgetMeter, formatMonthShort } from "@/lib/costs"
import { formatCount, formatHours, formatPercent, formatUsd } from "@/lib/format"
import { fieldOf, isGithubReady } from "@/lib/integration-workflows"
import { costMonthQuery, outcomesQuery, overviewQuery, settingsQuery } from "@/lib/queries"
import { useProjectId } from "@/lib/project"

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

const useOverview = (window: WindowKey) => useQuery(overviewQuery(useProjectId(), window))

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
          onValueChange={(next) => {
            const key = WINDOW_KEYS.find((k) => k === next[0])
            if (key) setWindow(key)
          }}
          variant="outline"
          aria-label="Time window"
        >
          {WINDOW_KEYS.map((key) => (
            <ToggleGroupItem key={key} value={key}>
              Last {key}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </PageHeader>

      <SetupBanner />
      <ResultTiles />

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

function SetupBanner() {
  const settings = useQuery(settingsQuery(useProjectId()))
  if (!settings.data || fieldOf(settings.data.integrations, "github", "token")?.set) return null
  return (
    <Alert role="status">
      <ListChecksIcon />
      <AlertTitle>This project is not set up yet</AlertTitle>
      <AlertDescription>The setup guide walks through the GitHub token, repositories and services.</AlertDescription>
      <AlertAction>
        <Button size="sm" nativeButton={false} render={<Link to="/setup" />}>
          Open setup
        </Button>
      </AlertAction>
    </Alert>
  )
}

function ResultTile({ to, label, children }: { to: "/outcomes" | "/costs"; label: string; children: React.ReactNode }) {
  return (
    <Link to={to} className="group/tile rounded-lg focus-visible:outline-2 focus-visible:outline-ring">
      <Card size="sm" className="h-full transition-colors group-hover/tile:bg-muted/40">
        <CardHeader className="gap-1.5">
          <CardDescription className="flex items-center justify-between gap-2">
            {label}
            <CaretRightIcon aria-hidden className="text-muted-foreground transition-transform group-hover/tile:translate-x-0.5" />
          </CardDescription>
          {children}
        </CardHeader>
      </Card>
    </Link>
  )
}

function ResultTiles() {
  const project = useProjectId()
  const settings = useQuery(settingsQuery(project))
  const githubReady = settings.data ? isGithubReady(settings.data.integrations) : undefined
  const outcomes = useQuery(outcomesQuery(project, 30))
  const cost = useQuery(costMonthQuery(project, undefined))
  const counts = outcomes.data?.overall
  const meter = cost.data ? budgetMeter(cost.data) : undefined

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <ResultTile to="/outcomes" label="Codex pull requests, last 30 days">
        {githubReady === false && counts !== undefined && counts.opened + counts.merged + counts.closed + counts.open === 0 ? (
          <p className="text-sm text-muted-foreground">Connect GitHub to see what Codex pull requests became.</p>
        ) : outcomes.error ? (
          <p className="text-sm text-muted-foreground">Outcomes are unavailable right now.</p>
        ) : !counts ? (
          <Skeleton className="h-8 w-32" />
        ) : (
          <>
            <CardTitle className="text-2xl tabular-nums">
              {formatCount(counts.merged)} <span className="text-base font-normal text-muted-foreground">merged</span>
            </CardTitle>
            <p className="text-xs text-muted-foreground tabular-nums">
              {formatPercent(counts.usefulRate)} useful
              {counts.medianHoursToMerge !== null && `, median ${formatHours(counts.medianHoursToMerge)} to merge`}
              {`, ${formatCount(counts.open)} open`}
            </p>
          </>
        )}
      </ResultTile>
      <ResultTile to="/costs" label={cost.data ? `LLM spend, ${formatMonthShort(cost.data.month)}` : "LLM spend this month"}>
        {cost.error ? (
          <p className="text-sm text-muted-foreground">Costs are unavailable right now.</p>
        ) : !cost.data || !meter ? (
          <Skeleton className="h-8 w-32" />
        ) : (
          <>
            <CardTitle className="text-2xl tabular-nums">
              {formatUsd(cost.data.totals.cost)}
              {meter.kind === "set" && <span className="text-base font-normal text-muted-foreground"> of {formatUsd(meter.budget)}</span>}
            </CardTitle>
            {meter.kind === "set" ? (
              <div aria-hidden className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                <div className={cn("h-full rounded-full", BUDGET_FILL[meter.tone])} style={{ width: `${Math.min(100, meter.ratio * 100)}%` }} />
              </div>
            ) : (
              <p className="text-xs text-muted-foreground tabular-nums">
                {formatCount(cost.data.totals.calls)} calls, no monthly budget set
              </p>
            )}
          </>
        )}
      </ResultTile>
    </div>
  )
}

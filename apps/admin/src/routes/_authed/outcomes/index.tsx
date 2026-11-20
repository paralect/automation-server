import { useCallback } from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { ArrowSquareOutIcon, WarningIcon } from "@phosphor-icons/react"
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts"

import type { OutcomeCounts, OutcomeSummary, PullRequestRow } from "@automation-server/api/routers/index"

import { PrStateBadge } from "@/components/badges"
import { EnumFilter } from "@/components/filters"
import { StatTile } from "@/components/stat-tile"
import { EmptyState, PageHeader, QueryError, RowsSkeleton } from "@/components/states"
import { SyncButton, SyncFeedback, syncedLabel, useSyncNow } from "@/components/sync-now"
import { Time } from "@/components/time"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { OUTCOME_WINDOW_DAYS, PR_STATES, outcomesSearch, type OutcomesSearch, type OutcomeWindow } from "@/lib/filters"
import { formatCount, formatHours, formatPercent } from "@/lib/format"
import { isGithubReady } from "@/lib/integration-workflows"
import { ORIGIN_KIND_LABEL, originKey, prBadgeState, prTiming, syncErrors, syncStatus } from "@/lib/outcomes"
import { useProjectId } from "@/lib/project"
import { outcomesQuery, pullRequestsQuery, settingsQuery } from "@/lib/queries"

export const Route = createFileRoute("/_authed/outcomes/")({
  validateSearch: outcomesSearch,
  component: Outcomes,
})

const DEFAULT_WINDOW: OutcomeWindow = 30

const chartConfig = {
  opened: { label: "Opened", color: "var(--pr-opened)" },
  merged: { label: "Merged", color: "var(--pr-merged)" },
  closed: { label: "Closed unmerged", color: "var(--pr-closed)" },
} satisfies ChartConfig

const WEEK = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" })
const weekLabel = (iso: string) => WEEK.format(new Date(iso))

function Outcomes() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const update = useCallback(
    (patch: Partial<OutcomesSearch>) => navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true }),
    [navigate]
  )
  const windowDays = search.window ?? DEFAULT_WINDOW

  const project = useProjectId()
  const settings = useQuery(settingsQuery(project))
  const githubReady = settings.data ? isGithubReady(settings.data.integrations) : undefined
  const summary = useQuery(outcomesQuery(project, windowDays))
  const sync = useSyncNow(project)
  const status = summary.data ? syncStatus(summary.data.sync) : undefined
  const hasHistory = summary.data !== undefined && !isEmpty(summary.data.overall)

  return (
    <>
      <PageHeader title="Outcomes" description="What the pull requests Codex opened became, and which automation started each one.">
        {githubReady !== false && (
          <div className="flex flex-wrap items-center gap-3">
            {status && (
              <p className="text-xs text-muted-foreground" aria-live="polite">
                {syncedLabel(status, "Synced")}
              </p>
            )}
            <SyncButton sync={sync} />
            <ToggleGroup
              value={[String(windowDays)]}
              onValueChange={(next) => {
                const days = OUTCOME_WINDOW_DAYS.find((d) => String(d) === next[0])
                if (days) update({ window: days === DEFAULT_WINDOW ? undefined : days })
              }}
              variant="outline"
              aria-label="Time window"
            >
              {OUTCOME_WINDOW_DAYS.map((days) => (
                <ToggleGroupItem key={days} value={String(days)}>
                  Last {days} d
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        )}
      </PageHeader>
      <SyncFeedback sync={sync} />

      {githubReady === false && hasHistory && (
        <Alert>
          <WarningIcon />
          <AlertTitle>GitHub is not connected</AlertTitle>
          <AlertDescription>These figures are from the last sync and stop updating until a GitHub token is set again.</AlertDescription>
        </Alert>
      )}
      {githubReady === false && summary.data !== undefined && !hasHistory ? (
        <EmptyState
          title="Connect GitHub to track Codex pull requests"
          hint="Outcomes are read from the pull requests Codex opens in your tracked repositories. Add a GitHub token and the repositories to watch."
        >
          <Button size="sm" nativeButton={false} render={<Link to="/integrations/$id" params={{ id: "github" }} />}>
            Set up GitHub
          </Button>
        </EmptyState>
      ) : summary.error ? (
        <QueryError error={summary.error} onRetry={() => summary.refetch()} />
      ) : (
        <SummaryView summary={summary.data} windowDays={windowDays} search={search} update={update} sync={sync} />
      )}
    </>
  )
}

function SummaryView({
  summary,
  windowDays,
  search,
  update,
  sync,
}: {
  summary: OutcomeSummary | undefined
  windowDays: OutcomeWindow
  search: OutcomesSearch
  update: (patch: Partial<OutcomesSearch>) => void
  sync: ReturnType<typeof useSyncNow>
}) {
  if (summary && summary.sync.length === 0 && isEmpty(summary.overall)) {
    return (
      <EmptyState title="No repositories tracked" hint="Outcomes follow the same repositories as GitHub Actions. Add one in the GitHub settings.">
        <Button size="sm" nativeButton={false} render={<Link to="/integrations/$id" params={{ id: "github" }} />}>
          Open GitHub settings
        </Button>
      </EmptyState>
    )
  }

  const repos = summary?.sync.map((s) => s.repo).join(", ")
  if (summary && syncStatus(summary.sync).kind === "never" && isEmpty(summary.overall)) {
    return (
      <EmptyState
        title="Not synced yet"
        hint={`The first sync reads the last 90 days of Codex pull requests from ${repos}. It then runs every hour.`}
      >
        <SyncButton sync={sync} />
      </EmptyState>
    )
  }

  const errors = summary ? syncErrors(summary.sync) : []
  const quietWindow = summary !== undefined && isEmpty(summary.overall)

  return (
    <>
      {errors.map(({ repo, error }) => (
        <Alert key={repo} role="alert">
          <WarningIcon />
          <AlertTitle>Could not sync {repo}</AlertTitle>
          <AlertDescription>{error}. Figures from the other repositories are still current.</AlertDescription>
        </Alert>
      ))}

      {quietWindow ? (
        <EmptyState
          title={`No Codex pull requests in the last ${windowDays} days`}
          hint={`Tracking ${repos}. Pull requests opened by the codex-issue-fix, linear-implement, codex-seo-autopilot and codex-changelog workflows appear here.`}
        >
          <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/workflows" />}>
            Install workflows
          </Button>
        </EmptyState>
      ) : (
        <>
          <KpiRow counts={summary?.overall} windowDays={windowDays} />
          <WeeklyChart summary={summary} />
          <ByOrigin summary={summary} activeOrigin={search.origin} onPick={(origin) => update({ origin })} />
        </>
      )}

      <PullRequests search={search} update={update} originOptions={summary?.byOrigin.map((row) => originKey(row.origin)) ?? []} />
    </>
  )
}

const isEmpty = (c: OutcomeCounts) => c.opened + c.merged + c.closed + c.open === 0

function KpiRow({ counts, windowDays }: { counts: OutcomeCounts | undefined; windowDays: OutcomeWindow }) {
  const loading = counts === undefined
  const resolved = counts ? counts.merged + counts.closed : 0
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
      <StatTile label="Opened" swatch="bg-pr-opened" loading={loading} value={counts && formatCount(counts.opened)} hint={`in ${windowDays} days`} />
      <StatTile label="Merged" swatch="bg-pr-merged" loading={loading} value={counts && formatCount(counts.merged)} hint="whenever opened" />
      <StatTile label="Closed unmerged" swatch="bg-pr-closed" loading={loading} value={counts && formatCount(counts.closed)} hint="whenever opened" />
      <StatTile label="Open now" loading={loading} value={counts && formatCount(counts.open)} hint="any age" />
      <StatTile
        label="Median time to merge"
        loading={loading}
        value={counts?.medianHoursToMerge == null ? "-" : formatHours(counts.medianHoursToMerge)}
        hint="opened to merged"
      />
      <StatTile
        label="Useful rate"
        loading={loading}
        value={formatPercent(counts?.usefulRate ?? null)}
        hint={resolved === 0 ? "nothing resolved yet" : `${counts?.merged} merged of ${resolved} resolved`}
      />
    </div>
  )
}

function WeeklyChart({ summary }: { summary: OutcomeSummary | undefined }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Week by week</CardTitle>
        <CardDescription>Pull requests merged and closed each week, against how many were opened. Weeks start on Monday, UTC.</CardDescription>
      </CardHeader>
      <CardContent>
        {!summary ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <ChartContainer config={chartConfig} className="h-64 w-full">
            <ComposedChart data={[...summary.weekly]} accessibilityLayer barGap={2}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="start" tickFormatter={weekLabel} tickLine={false} axisLine={false} minTickGap={16} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={28} />
              <ChartTooltip
                content={<ChartTooltipContent labelFormatter={(_, p) => `Week of ${weekLabel(String(p[0]?.payload.start))}`} />}
              />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar isAnimationActive={false} dataKey="merged" stackId="resolved" fill="var(--color-merged)" maxBarSize={24} />
              <Bar
                isAnimationActive={false}
                dataKey="closed"
                stackId="resolved"
                fill="var(--color-closed)"
                stroke="var(--card)"
                strokeWidth={2}
                radius={[4, 4, 0, 0]}
                maxBarSize={24}
              />
              <Line
                isAnimationActive={false}
                dataKey="opened"
                type="linear"
                stroke="var(--color-opened)"
                strokeWidth={2}
                dot={{ r: 4, fill: "var(--color-opened)", stroke: "var(--card)", strokeWidth: 2 }}
                activeDot={{ r: 5, stroke: "var(--card)", strokeWidth: 2 }}
              />
            </ComposedChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}

function UsefulMeter({ rate }: { rate: number | null }) {
  if (rate === null) return <span className="text-muted-foreground">-</span>
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span aria-hidden className="h-1.5 w-12 overflow-hidden rounded-full bg-pr-closed/35">
        <span className="block h-full rounded-full bg-pr-merged" style={{ width: `${Math.round(rate * 100)}%` }} />
      </span>
      <span className="w-9 text-right">{formatPercent(rate)}</span>
    </span>
  )
}

function ByOrigin({
  summary,
  activeOrigin,
  onPick,
}: {
  summary: OutcomeSummary | undefined
  activeOrigin: string | undefined
  onPick: (origin: string | undefined) => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>By origin</CardTitle>
        <CardDescription>
          The automation that started the work, or the workflow when nothing on this server did. Pick a row to filter the list below.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!summary ? (
          <RowsSkeleton rows={3} />
        ) : summary.byOrigin.length === 0 ? (
          <EmptyState title="No origins in this window" />
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-full">Origin</TableHead>
                  <TableHead className="text-right">Opened</TableHead>
                  <TableHead className="text-right">Merged</TableHead>
                  <TableHead className="text-right">Closed</TableHead>
                  <TableHead className="text-right">Open</TableHead>
                  <TableHead className="text-right whitespace-nowrap">Median to merge</TableHead>
                  <TableHead className="text-right">Useful</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="tabular-nums">
                {summary.byOrigin.map((row) => {
                  const key = originKey(row.origin)
                  const active = activeOrigin === key
                  return (
                    <TableRow key={`${row.origin.kind}:${key}`} data-state={active ? "selected" : undefined}>
                      <TableCell>
                        <button
                          type="button"
                          aria-pressed={active}
                          onClick={() => onPick(active ? undefined : key)}
                          className="rounded-sm text-left underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                        >
                          <span className="block font-medium">{key}</span>
                          <span className="block text-muted-foreground">{ORIGIN_KIND_LABEL[row.origin.kind]}</span>
                        </button>
                      </TableCell>
                      <TableCell className="text-right">{formatCount(row.opened)}</TableCell>
                      <TableCell className="text-right">{formatCount(row.merged)}</TableCell>
                      <TableCell className="text-right">{formatCount(row.closed)}</TableCell>
                      <TableCell className="text-right">{formatCount(row.open)}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        {row.medianHoursToMerge === null ? <span className="text-muted-foreground">-</span> : formatHours(row.medianHoursToMerge)}
                      </TableCell>
                      <TableCell className="text-right">
                        <UsefulMeter rate={row.usefulRate} />
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function PullRequests({
  search,
  update,
  originOptions,
}: {
  search: OutcomesSearch
  update: (patch: Partial<OutcomesSearch>) => void
  originOptions: readonly string[]
}) {
  const project = useProjectId()
  const filters = { state: search.state, origin: search.origin }
  const query = useInfiniteQuery(pullRequestsQuery(project, filters))
  const rows = query.data?.pages.flatMap((page) => page.items) ?? []
  const origins = search.origin && !originOptions.includes(search.origin) ? [...originOptions, search.origin] : originOptions
  const filtered = Boolean(search.state || search.origin)
  const nowIso = new Date().toISOString()

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pull requests</CardTitle>
        <CardDescription>Every tracked Codex pull request, newest first, whatever the window.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <EnumFilter label="State" value={search.state} options={PR_STATES} onChange={(state) => update({ state })} />
          <EnumFilter label="Origin" value={search.origin} options={origins} onChange={(origin) => update({ origin })} />
          {filtered && (
            <Button variant="ghost" size="sm" className="self-center" onClick={() => update({ state: undefined, origin: undefined })}>
              Clear filters
            </Button>
          )}
        </div>

        {query.error ? (
          <QueryError error={query.error} onRetry={() => query.refetch()} />
        ) : query.isPending ? (
          <RowsSkeleton rows={5} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No pull requests"
            hint={filtered ? "Nothing matches these filters." : "Pull requests appear here after the next sync finds one."}
          />
        ) : (
          <>
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-full min-w-64">Pull request</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Origin</TableHead>
                    <TableHead>Opened</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead>
                      <span className="sr-only">Origin run</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((pr) => (
                    <PullRequestTableRow key={pr.seq} pr={pr} nowIso={nowIso} />
                  ))}
                </TableBody>
              </Table>
            </div>
            {query.hasNextPage && (
              <Button variant="outline" className="self-center" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
                {query.isFetchingNextPage ? "Loading..." : "Load more"}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function PullRequestTableRow({ pr, nowIso }: { pr: PullRequestRow; nowIso: string }) {
  return (
    <TableRow>
      <TableCell className="max-w-0">
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="group/pr flex min-w-0 items-center gap-1 font-medium underline-offset-4 hover:underline focus-visible:underline"
          title={pr.title}
        >
          <span className="truncate">{pr.title}</span>
          <ArrowSquareOutIcon aria-hidden className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/pr:opacity-100" />
        </a>
        <p className="truncate font-mono text-[0.6875rem] text-muted-foreground">
          {pr.repo}#{pr.number}
        </p>
      </TableCell>
      <TableCell>
        <PrStateBadge state={prBadgeState(pr.lifecycle)} />
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <span className="block">{originKey(pr.origin)}</span>
        <span className="block text-muted-foreground">{pr.origin.kind === "automation" ? `via ${pr.producer}` : ORIGIN_KIND_LABEL.workflow}</span>
      </TableCell>
      <TableCell className="text-xs">
        <Time iso={pr.createdAt} relativeOnly />
      </TableCell>
      <TableCell className="whitespace-nowrap tabular-nums">{prTiming(pr, nowIso)}</TableCell>
      <TableCell className="whitespace-nowrap">
        {pr.originRunId ? (
          <Link to="/runs/$id" params={{ id: pr.originRunId }} className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            Run
          </Link>
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
      </TableCell>
    </TableRow>
  )
}

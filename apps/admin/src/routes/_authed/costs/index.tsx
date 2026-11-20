import { Link, createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { BellSimpleIcon, InfoIcon } from "@phosphor-icons/react"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { cn } from "cn"

import type { CostMonth } from "@automation-server/api/routers/index"

import { StatTile } from "@/components/stat-tile"
import { Time } from "@/components/time"
import { EmptyState, PageHeader, QueryError, RowsSkeleton } from "@/components/states"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { budgetMeter, costPerRun, formatMonth, formatMonthShort, monthOf, recentMonths } from "@/lib/costs"
import { BUDGET_FILL, BUDGET_TEXT } from "@/lib/badge-styles"
import { costsSearch } from "@/lib/filters"
import { formatCompact, formatCount, formatUsd, formatUsdAxis, splitMicroUsd, toUsd } from "@/lib/format"
import { useProjectId } from "@/lib/project"
import { costMonthQuery, settingsQuery } from "@/lib/queries"

export const Route = createFileRoute("/_authed/costs/")({
  validateSearch: costsSearch,
  component: Costs,
})

const chartConfig = {
  usd: { label: "Spend", theme: { light: "oklch(0.439 0 0)", dark: "oklch(0.708 0 0)" } },
} satisfies ChartConfig

const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" })
const dayLabel = (day: string) => DAY.format(new Date(`${day}T00:00:00Z`))
const ALERT_DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })

function Costs() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const project = useProjectId()
  const current = monthOf(new Date())
  const month = search.month ?? current
  const months = recentMonths(new Date())

  const settings = useQuery(settingsQuery(project))
  const openrouterReady = settings.data?.integrations.find((i) => i.id === "openrouter")?.configured
  const cost = useQuery(costMonthQuery(project, search.month))
  const data = cost.data

  return (
    <>
      <PageHeader title="Costs" description="What the LLM calls this server makes through OpenRouter cost, by calendar month (UTC).">
        <Select
          value={month}
          onValueChange={(next) => {
            const picked = months.find((m) => m === next)
            if (picked) void navigate({ search: { month: picked === current ? undefined : picked }, replace: true })
          }}
        >
          <SelectTrigger aria-label="Month" className="w-44">
            <SelectValue>{(v: string) => formatMonth(v)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {months.map((m) => (
              <SelectItem key={m} value={m}>
                {formatMonth(m)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PageHeader>

      {cost.error ? (
        <QueryError error={cost.error} onRetry={() => cost.refetch()} />
      ) : openrouterReady === false && data?.totals.calls === 0 ? (
        <EmptyState
          title="OpenRouter is not configured"
          hint="Costs come from the LLM calls automations make through OpenRouter, such as Crisp triage and the Slack bot. Add an OpenRouter key to start recording them."
        >
          <Button size="sm" nativeButton={false} render={<Link to="/integrations/$id" params={{ id: "openrouter" }} />}>
            Set up OpenRouter
          </Button>
        </EmptyState>
      ) : (
        <>
          <BudgetCard cost={data} />
          <KpiRow cost={data} />
          {data && data.totals.unpriced > 0 && (
            <Alert>
              <InfoIcon />
              <AlertDescription>
                {formatCount(data.totals.unpriced)} {data.totals.unpriced === 1 ? "call" : "calls"} returned no price and{" "}
                {data.totals.unpriced === 1 ? "is" : "are"} not included in the totals. Their tokens are counted.
              </AlertDescription>
            </Alert>
          )}
          {data && data.totals.calls === 0 ? (
            <EmptyState
              title={`No LLM calls in ${formatMonth(data.month)}`}
              hint="Calls are recorded as automations make them. Crisp triage and the Slack bot are the automations that call a model."
            />
          ) : (
            <>
              <DailyChart cost={data} />
              <div className="grid gap-4 xl:grid-cols-2">
                <ByAutomation cost={data} />
                <ByModel cost={data} />
              </div>
              <TopRuns cost={data} />
            </>
          )}
        </>
      )}
    </>
  )
}

function BudgetCard({ cost }: { cost: CostMonth | undefined }) {
  if (!cost) return <Skeleton className="h-36 w-full rounded-lg" />
  const meter = budgetMeter(cost)
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`

  return (
    <Card>
      <CardHeader>
        <CardTitle>Budget</CardTitle>
        <CardDescription>
          {meter.kind === "none"
            ? `Spent in ${formatMonth(cost.month)}. No monthly budget is set.`
            : "Slack alerts go to the failure alerts channel at 80% and 100% of the monthly budget."}
        </CardDescription>
        {meter.kind === "set" && (
          <CardAction>
            <AlertsSent alerts={cost.alerts} />
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-3xl font-medium tabular-nums">{formatUsd(cost.totals.cost)}</span>
          {meter.kind === "set" && (
            <>
              <span className="text-sm text-muted-foreground tabular-nums">of {formatUsd(meter.budget)}</span>
              <span className={cn("ml-auto text-sm font-medium tabular-nums", BUDGET_TEXT[meter.tone])}>
                {Math.round(meter.ratio * 100)}% used
              </span>
            </>
          )}
        </div>

        {meter.kind === "none" ? (
          <p className="text-sm text-muted-foreground">
            <Link to="/integrations/$id" params={{ id: "openrouter" }} className="text-foreground underline underline-offset-4">
              Set a monthly budget
            </Link>{" "}
            in the OpenRouter settings to get a Slack alert at 80% and 100% of it.
          </p>
        ) : (
          <div className="pt-5 pb-5">
            <div
              role="meter"
              aria-label="Monthly budget used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(meter.ratio * 100)}
              aria-valuetext={`${formatUsd(meter.spent)} of ${formatUsd(meter.budget)}`}
              className="relative h-2 rounded-full bg-muted"
            >
              <div className={cn("h-full rounded-full", BUDGET_FILL[meter.tone])} style={{ width: pct(meter.scale.spent) }} />
              {meter.scale.projected !== null && meter.scale.projected > meter.scale.spent && (
                <div
                  className="absolute -top-1.5 h-5 -translate-x-1/2 border-l-2 border-dotted border-foreground/50"
                  style={{ left: pct(meter.scale.projected) }}
                >
                  <span
                    className={`absolute bottom-full mb-0.5 text-[0.6875rem] whitespace-nowrap text-muted-foreground tabular-nums ${
                      meter.scale.projected > 0.85 ? "right-0" : "left-0 -translate-x-1/2"
                    }`}
                  >
                    Projected {cost.projected !== null && formatUsd(cost.projected)}
                  </span>
                </div>
              )}
              {[
                { at: meter.scale.at80, label: "80%" },
                { at: meter.scale.at100, label: "100%" },
              ].map((mark) => (
                <div key={mark.label} className="absolute -top-1 h-4 w-px -translate-x-1/2 bg-foreground/60" style={{ left: pct(mark.at) }}>
                  <span className="absolute top-full left-0 mt-0.5 -translate-x-1/2 text-[0.6875rem] text-muted-foreground tabular-nums">
                    {mark.label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function AlertsSent({ alerts }: { alerts: CostMonth["alerts"] }) {
  if (alerts.length === 0) return <p className="text-xs text-muted-foreground">No alerts sent</p>
  return (
    <ul className="flex flex-col items-end gap-0.5 text-xs">
      {alerts.map((alert) => (
        <li key={alert.thresholdPct} className="flex items-center gap-1.5">
          <BellSimpleIcon aria-hidden className={alert.thresholdPct >= 100 ? "text-destructive" : "text-amber-600 dark:text-amber-400"} />
          <span>
            {alert.thresholdPct}% alert sent{" "}
            <time dateTime={alert.sentAt} title={alert.sentAt} className="text-muted-foreground">
              {ALERT_DATE.format(new Date(alert.sentAt))}
            </time>
          </span>
        </li>
      ))}
    </ul>
  )
}

function KpiRow({ cost }: { cost: CostMonth | undefined }) {
  const loading = cost === undefined
  const perRun = cost ? costPerRun(cost.byAutomation) : null
  const overPace = cost && cost.budget !== null && cost.projected !== null && cost.projected > cost.budget
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
      <StatTile label="Spend" loading={loading} value={cost && formatUsd(cost.totals.cost)} hint={cost && formatMonthShort(cost.month)} />
      <StatTile
        label="Projected month-end"
        loading={loading}
        value={cost?.projected == null ? "-" : formatUsd(cost.projected)}
        hint={
          cost?.projected == null ? (
            cost?.month === monthOf(new Date()) ? "no priced calls yet" : "month closed"
          ) : overPace ? (
            <span className="text-amber-700 dark:text-amber-400">over budget at this pace</span>
          ) : (
            "at the current pace"
          )
        }
      />
      <StatTile label="Calls" loading={loading} value={cost && formatCount(cost.totals.calls)} hint={cost && `${formatCount(cost.totals.unpriced)} unpriced`} />
      <StatTile label="Tokens in" loading={loading} value={cost && formatCompact(cost.totals.promptTokens)} hint="prompt" />
      <StatTile label="Tokens out" loading={loading} value={cost && formatCompact(cost.totals.completionTokens)} hint="completion" />
      <StatTile label="Per run" loading={loading} value={perRun === null ? "-" : formatUsd(perRun)} hint="runs that called a model" />
    </div>
  )
}

function DailyChart({ cost }: { cost: CostMonth | undefined }) {
  const data = cost?.daily.map((d) => ({ day: d.day, usd: toUsd(d.cost), cost: d.cost }))
  return (
    <Card>
      <CardHeader>
        <CardTitle>Daily spend</CardTitle>
        <CardDescription>Priced calls only, by UTC day.</CardDescription>
      </CardHeader>
      <CardContent>
        {!data ? (
          <Skeleton className="h-56 w-full" />
        ) : (
          <ChartContainer config={chartConfig} className="h-56 w-full">
            <BarChart data={data} accessibilityLayer>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="day" tickFormatter={dayLabel} tickLine={false} axisLine={false} minTickGap={16} />
              <YAxis tickFormatter={formatUsdAxis} tickLine={false} axisLine={false} width={48} />
              <ChartTooltip
                cursor={{ fill: "var(--muted)" }}
                content={
                  <ChartTooltipContent
                    labelFormatter={(_, p) => dayLabel(String(p[0]?.payload.day))}
                    formatter={(_value, _name, item) => (
                      <span className="flex w-full justify-between gap-4">
                        <span className="text-muted-foreground">Spend</span>
                        <span className="font-mono font-medium tabular-nums">{formatUsd(item.payload.cost)}</span>
                      </span>
                    )}
                  />
                }
              />
              <Bar isAnimationActive={false} dataKey="usd" fill="var(--color-usd)" radius={[4, 4, 0, 0]} maxBarSize={24} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}

function TableCard({ title, description, loading, children }: { title: string; description: string; loading: boolean; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{loading ? <RowsSkeleton rows={3} /> : <div className="rounded-lg border">{children}</div>}</CardContent>
    </Card>
  )
}

const OUTSIDE_RUN = <span className="text-muted-foreground italic">Outside a run</span>

function ByAutomation({ cost }: { cost: CostMonth | undefined }) {
  return (
    <TableCard title="By automation" description="Which automations call a model, and what one run of each costs." loading={!cost}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-full">Automation</TableHead>
            <TableHead className="text-right">Runs</TableHead>
            <TableHead className="text-right">Calls</TableHead>
            <TableHead className="text-right">Tokens</TableHead>
            <TableHead className="text-right">Cost</TableHead>
            <TableHead className="text-right">Per run</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="tabular-nums">
          {cost?.byAutomation
            .filter((row) => row.automation !== null || row.calls > 0)
            .map((row) => (
              <TableRow key={row.automation ?? "outside"}>
                <TableCell className="font-medium">{row.automation ?? OUTSIDE_RUN}</TableCell>
                <TableCell className="text-right">{row.automation === null ? "-" : formatCount(row.runs)}</TableCell>
                <TableCell className="text-right">{formatCount(row.calls)}</TableCell>
                <TableCell className="text-right">{formatCompact(row.promptTokens + row.completionTokens)}</TableCell>
                <TableCell className="text-right">{formatUsd(row.cost)}</TableCell>
                <TableCell className="text-right">
                  {row.automation === null || row.runs === 0 ? "-" : formatUsd(splitMicroUsd(row.cost, row.runs))}
                </TableCell>
              </TableRow>
            ))}
        </TableBody>
      </Table>
    </TableCard>
  )
}

function ByModel({ cost }: { cost: CostMonth | undefined }) {
  return (
    <TableCard title="By model" description="Spend per OpenRouter model." loading={!cost}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-full">Model</TableHead>
            <TableHead className="text-right">Calls</TableHead>
            <TableHead className="text-right">In</TableHead>
            <TableHead className="text-right">Out</TableHead>
            <TableHead className="text-right">Cost</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="tabular-nums">
          {cost?.byModel.map((row) => (
            <TableRow key={row.model}>
              <TableCell className="max-w-0 truncate font-mono text-[0.6875rem]" title={row.model}>
                {row.model}
              </TableCell>
              <TableCell className="text-right">{formatCount(row.calls)}</TableCell>
              <TableCell className="text-right">{formatCompact(row.promptTokens)}</TableCell>
              <TableCell className="text-right">{formatCompact(row.completionTokens)}</TableCell>
              <TableCell className="text-right">
                {formatUsd(row.cost)}
                {row.unpriced > 0 && <span className="block text-[0.6875rem] text-muted-foreground">{formatCount(row.unpriced)} unpriced</span>}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableCard>
  )
}

function TopRuns({ cost }: { cost: CostMonth | undefined }) {
  if (cost && cost.topRuns.length === 0) return null
  return (
    <TableCard title="Costliest runs" description="The ten runs that spent the most this month." loading={!cost}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-full">Run</TableHead>
            <TableHead>Started</TableHead>
            <TableHead className="text-right">Calls</TableHead>
            <TableHead className="text-right">Cost</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="tabular-nums">
          {cost?.topRuns.map((run) => (
            <TableRow key={run.runId}>
              <TableCell>
                <Link to="/runs/$id" params={{ id: run.runId }} className="font-medium underline-offset-4 hover:underline focus-visible:underline">
                  {run.automation ?? "Unknown automation"}
                </Link>
                <span className="ml-2 font-mono text-[0.6875rem] text-muted-foreground">{run.runId.slice(0, 12)}</span>
              </TableCell>
              <TableCell className="text-xs whitespace-nowrap">
                <Time iso={run.at} />
              </TableCell>
              <TableCell className="text-right">{formatCount(run.calls)}</TableCell>
              <TableCell className="text-right">{formatUsd(run.cost)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableCard>
  )
}

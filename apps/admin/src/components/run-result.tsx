import { useState, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  BugIcon,
  CaretDownIcon,
  CaretRightIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  GithubLogoIcon,
  HourglassMediumIcon,
  KanbanIcon,
  LightningIcon,
  PlayIcon,
  WarningIcon,
  type Icon,
} from "@phosphor-icons/react"
import { cn } from "cn"

import type { LlmCallRow, PullRequestRecord, RunTrace, WorkflowRunRecord, WorkItemTrace } from "@automation-server/api/routers/index"

import { ActionStateIcon } from "@/components/action-state"
import { PrStateBadge } from "@/components/badges"
import { ExternalLink } from "@/components/external-link"
import { SyncButton, SyncFeedback, syncedLabel, useSyncNow } from "@/components/sync-now"
import { Time } from "@/components/time"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { errorKind, errorText } from "@/lib/errors"
import { formatCompact, formatCount, formatUsd } from "@/lib/format"
import { MATCH_COPY, hasResult, prBadgeState, prTiming, workRefLabel } from "@/lib/outcomes"
import { isActiveState, runTraceQuery } from "@/lib/queries"
import { formatElapsed } from "@/lib/time"

type Trace = RunTrace & { trigger: { source: string; externalId: string; url: string | null } }

export function RunResult({ project, runId }: { project: string; runId: string }) {
  const trace = useQuery(runTraceQuery(project, runId))

  if (trace.isPending) return <Skeleton className="h-44 w-full rounded-lg" />
  if (trace.error) {
    if (errorKind(trace.error) === "not-found") return null
    // The run itself loaded, so a failed trace stays a quiet line instead of an alert over the whole page.
    return (
      <p role="status" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        The result of this run could not be loaded: {errorText(trace.error)}
        <Button variant="ghost" size="xs" onClick={() => trace.refetch()}>
          Retry
        </Button>
      </p>
    )
  }
  if (!hasResult(trace.data)) return null
  return <ResultCard project={project} trace={trace.data} />
}

function ResultCard({ project, trace }: { project: string; trace: Trace }) {
  const sync = useSyncNow(project)
  const hasWork = trace.workItems.length > 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>Result</CardTitle>
        <CardDescription>
          {hasWork ? "Where the work this run started went, from the trigger to the pull request." : "What this run spent on model calls."}
        </CardDescription>
        {hasWork && (
          <CardAction className="flex items-center gap-2">
            <span className="hidden text-xs text-muted-foreground sm:inline" title={trace.syncedAt ?? undefined}>
              {syncedLabel(trace.syncedAt ? { kind: "synced", at: trace.syncedAt } : { kind: "never" }, "As of")}
            </span>
            <SyncButton sync={sync} label="Refresh" />
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {hasWork && <SyncFeedback sync={sync} />}
        {trace.workItems.map((item, index) => (
          <Chain key={item.key} item={item} trigger={index === 0 ? trace.trigger : null} />
        ))}
        {trace.llm.calls.length > 0 && <LlmUsage llm={trace.llm} separated={hasWork} />}
      </CardContent>
    </Card>
  )
}

// Four steps and three connectors share one grid, so every work item's steps line up under the ones above.
const CHAIN_GRID =
  "flex flex-col md:grid md:grid-cols-[minmax(0,1fr)_2rem_minmax(0,1fr)_2rem_minmax(0,1fr)_2rem_minmax(0,1fr)] md:items-stretch"

function Chain({ item, trigger }: { item: WorkItemTrace; trigger: Trace["trigger"] | null }) {
  const hasRuns = item.workflowRuns.length > 0
  const hasPrs = item.pullRequests.length > 0
  return (
    <ol className={CHAIN_GRID} aria-label={`Chain for ${workRefLabel(item.ref)}`}>
      {trigger ? (
        <>
          <TriggerStep trigger={trigger} />
          <Connector reached />
        </>
      ) : (
        <li aria-hidden className="hidden md:col-span-2 md:block" />
      )}
      <IssueStep item={item} />
      <Connector reached={hasRuns} />
      <WorkflowStep item={item} />
      <Connector reached={hasPrs} />
      <PullRequestStep item={item} />
    </ol>
  )
}

function Connector({ reached }: { reached: boolean }) {
  return (
    <li aria-hidden className="flex items-center pl-[1.5625rem] md:items-start md:pt-[1.5625rem] md:pl-0">
      <span className={cn("h-4 border-l md:h-0 md:w-full md:border-t md:border-l-0", reached ? "border-foreground/30" : "border-dashed border-border")} />
      {reached && <CaretRightIcon weight="bold" className="hidden size-2.5 shrink-0 -translate-x-1 -translate-y-[0.3rem] text-foreground/30 md:block" />}
    </li>
  )
}

function Step({
  icon: Glyph,
  label,
  tone = "default",
  children,
}: {
  icon: Icon
  label: string
  tone?: "default" | "empty" | "warn" | "merged"
  children: ReactNode
}) {
  return (
    <li
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3",
        tone === "empty" && "border-dashed bg-transparent",
        tone === "warn" && "border-amber-500/40 bg-amber-500/5",
        tone === "merged" && "border-pr-merged/40"
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-foreground",
            tone === "empty" && "bg-transparent text-muted-foreground ring-1 ring-border ring-inset",
            tone === "warn" && "bg-amber-500/15 text-amber-700 dark:text-amber-400",
            tone === "merged" && "bg-pr-merged/15 text-emerald-700 dark:text-emerald-400"
          )}
        >
          <Glyph aria-hidden className="size-3.5" />
        </span>
        <span className="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5 text-xs">{children}</div>
    </li>
  )
}

const Muted = ({ children }: { children: ReactNode }) => <p className="text-muted-foreground">{children}</p>

function TriggerStep({ trigger }: { trigger: Trace["trigger"] }) {
  const sentry = trigger.source === "sentry"
  return (
    <Step icon={sentry ? BugIcon : LightningIcon} label={sentry ? "Sentry issue" : `Trigger: ${trigger.source}`}>
      <p className="truncate font-mono text-sm" title={trigger.externalId}>
        {trigger.url ? <ExternalLink href={trigger.url}>{trigger.externalId}</ExternalLink> : trigger.externalId}
      </p>
      {!trigger.url && sentry && <Muted>The event is no longer stored, so there is no link.</Muted>}
    </Step>
  )
}

function IssueStep({ item }: { item: WorkItemTrace }) {
  const github = item.ref.kind === "github-issue"
  const label = workRefLabel(item.ref)
  return (
    <Step icon={github ? GithubLogoIcon : KanbanIcon} label={github ? "GitHub issue" : "Linear issue"}>
      <p className="truncate text-sm font-medium" title={label}>
        {item.url ? <ExternalLink href={item.url}>{label}</ExternalLink> : label}
      </p>
      <Muted>{item.createdByThisRun ? "Created by this run" : "Existing issue, work dispatched by this run"}</Muted>
      {item.dispatches.map((dispatch) => (
        <p key={`${dispatch.at}:${dispatch.workflowFile}`} className="flex flex-wrap items-center gap-x-1 text-muted-foreground">
          <PlayIcon aria-hidden className="size-3" />
          <span>Dispatched</span>
          <span className="font-mono text-foreground">{dispatch.workflowFile}</span>
          <Time iso={dispatch.at} relativeOnly />
        </p>
      ))}
    </Step>
  )
}

function WorkflowStep({ item }: { item: WorkItemTrace }) {
  const runs = item.workflowRuns
  if (runs.length === 0) {
    if (item.missingRun) {
      return (
        <Step icon={WarningIcon} label="Workflow run" tone="warn">
          <p className="font-medium text-amber-700 dark:text-amber-400">No run appeared</p>
          <Muted>Dispatched over 30 minutes ago and GitHub has no run for it. It was likely dropped from the queue; dispatch it again.</Muted>
        </Step>
      )
    }
    if (item.dispatches.length > 0) {
      return (
        <Step icon={HourglassMediumIcon} label="Workflow run" tone="empty">
          <Muted>Waiting for GitHub to start the run.</Muted>
        </Step>
      )
    }
    return (
      <Step icon={PlayIcon} label="Workflow run" tone="empty">
        <Muted>No Codex workflow ran for this issue.</Muted>
      </Step>
    )
  }
  return (
    <Step icon={PlayIcon} label={runs.length > 1 ? `Workflow runs, ${runs.length} attempts` : "Workflow run"}>
      <ul className="flex flex-col gap-1.5">
        {runs.map((run) => (
          <WorkflowRunLine key={`${run.repo}:${run.id}`} run={run} />
        ))}
      </ul>
    </Step>
  )
}

function WorkflowRunLine({ run }: { run: WorkflowRunRecord }) {
  const match = run.link ? MATCH_COPY[run.link.match] : null
  return (
    <li className="flex min-w-0 items-start gap-1.5">
      <span className="mt-px" title={run.state}>
        <ActionStateIcon state={run.state} className="size-3.5" />
        <span className="sr-only">{run.state}</span>
      </span>
      <div className="min-w-0">
        <Link
          to="/actions/$id"
          params={{ id: String(run.id) }}
          search={{ repo: run.repo }}
          className="block truncate text-sm font-medium underline-offset-4 hover:underline focus-visible:underline"
          title={run.title}
        >
          {run.producer} #{run.runNumber}
        </Link>
        <p className="text-muted-foreground">
          {run.state}
          {match && (
            <>
              {", "}
              <span title={match.detail} className="cursor-help underline decoration-dotted underline-offset-2">
                matched {match.label}
              </span>
            </>
          )}
        </p>
      </div>
    </li>
  )
}

function PullRequestStep({ item }: { item: WorkItemTrace }) {
  const prs = item.pullRequests
  if (prs.length === 0) {
    const running = item.workflowRuns.some((run) => isActiveState(run.state))
    return (
      <Step icon={GitPullRequestIcon} label="Pull request" tone="empty">
        <Muted>{running ? "The workflow is still running." : "No pull request was opened."}</Muted>
      </Step>
    )
  }
  const merged = prs.some((pr) => pr.lifecycle.state === "merged")
  return (
    <Step icon={merged ? GitMergeIcon : GitPullRequestIcon} label={prs.length > 1 ? `Pull requests, ${prs.length}` : "Pull request"} tone={merged ? "merged" : "default"}>
      <ul className="flex flex-col gap-2">
        {prs.map((pr) => (
          <PullRequestLine key={`${pr.repo}#${pr.number}`} pr={pr} />
        ))}
      </ul>
    </Step>
  )
}

function PullRequestLine({ pr }: { pr: PullRequestRecord }) {
  return (
    <li className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <PrStateBadge state={prBadgeState(pr.lifecycle)} />
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="truncate text-sm font-medium underline-offset-4 hover:underline focus-visible:underline"
          title={pr.title}
        >
          #{pr.number} {pr.title}
        </a>
      </div>
      <p className="text-muted-foreground tabular-nums">{prTiming(pr, new Date().toISOString())}</p>
    </li>
  )
}

function LlmUsage({ llm, separated }: { llm: RunTrace["llm"]; separated: boolean }) {
  const [open, setOpen] = useState(false)
  const { totals } = llm
  return (
    <section aria-label="LLM usage" className={cn("flex flex-col gap-3", separated && "border-t pt-4")}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">LLM usage</h3>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          {open ? <CaretDownIcon aria-hidden /> : <CaretRightIcon aria-hidden />}
          {open ? "Hide calls" : `Show ${totals.calls === 1 ? "the call" : `${totals.calls} calls`}`}
        </button>
      </div>
      <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <UsageFigure label="Calls">{formatCount(totals.calls)}</UsageFigure>
        <UsageFigure label="Tokens in">{formatCompact(totals.promptTokens)}</UsageFigure>
        <UsageFigure label="Tokens out">{formatCompact(totals.completionTokens)}</UsageFigure>
        <UsageFigure label="Cost">
          {formatUsd(totals.cost)}
          {totals.unpriced > 0 && <span className="ml-1.5 text-xs text-muted-foreground">+ {totals.unpriced} unpriced</span>}
        </UsageFigure>
      </dl>
      {open && <LlmCallTable calls={llm.calls} />}
    </section>
  )
}

function UsageFigure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm tabular-nums">{children}</dd>
    </div>
  )
}

function LlmCallTable({ calls }: { calls: readonly LlmCallRow[] }) {
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead className="w-full">Model</TableHead>
            <TableHead>Purpose</TableHead>
            <TableHead className="text-right">In</TableHead>
            <TableHead className="text-right">Out</TableHead>
            <TableHead className="text-right">Took</TableHead>
            <TableHead className="text-right">Cost</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="tabular-nums">
          {calls.map((call) => (
            <TableRow key={call.id}>
              <TableCell className="whitespace-nowrap">
                <time dateTime={call.at} title={call.at}>
                  {new Date(call.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </time>
              </TableCell>
              <TableCell className="max-w-0 truncate font-mono text-[0.6875rem]" title={call.model}>
                {call.model}
              </TableCell>
              <TableCell className="whitespace-nowrap">{call.purpose}</TableCell>
              <TableCell className="text-right">{formatCount(call.promptTokens)}</TableCell>
              <TableCell className="text-right">{formatCount(call.completionTokens)}</TableCell>
              <TableCell className="text-right whitespace-nowrap">{formatElapsed(call.durationMs)}</TableCell>
              <TableCell className="text-right whitespace-nowrap">
                {call.cost === null ? <span className="text-muted-foreground">unpriced</span> : formatUsd(call.cost)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

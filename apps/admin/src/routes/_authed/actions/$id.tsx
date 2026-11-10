import { Link, createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { ArrowSquareOutIcon } from "@phosphor-icons/react"
import { z } from "zod"
import { cn } from "cn"

import { ActionStateBadge, ActionStateIcon, Elapsed, useNow } from "@/components/action-state"
import { EmptyState, PageHeader, QueryError } from "@/components/states"
import { Time } from "@/components/time"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { errorKind } from "@/lib/errors"
import { actionRunQuery, isActiveState } from "@/lib/queries"

export const Route = createFileRoute("/_authed/actions/$id")({
  validateSearch: z.object({ repo: z.string().min(3).max(200).catch("") }),
  component: ActionRunDetail,
})

type Detail = NonNullable<ReturnType<typeof useActionRun>["data"]>
type Job = Detail["jobs"][number]

const useActionRun = (repo: string, id: number) => useQuery({ ...actionRunQuery(repo, id), enabled: repo !== "" && id > 0 })

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm">{children}</dd>
    </div>
  )
}

function ActionRunDetail() {
  const { id: rawId } = Route.useParams()
  const { repo } = Route.useSearch()
  const id = Number(rawId)
  const { data, error, refetch } = useActionRun(repo, id)
  const active = data ? isActiveState(data.run.state) : false
  const now = useNow(active)

  if ((error && errorKind(error) === "not-found") || repo === "" || !Number.isInteger(id) || id <= 0) {
    return (
      <>
        <EmptyState title="Workflow run not found" hint="The run does not exist, or its repository is not tracked." />
        <Button variant="outline" className="self-center" nativeButton={false} render={<Link to="/actions" />}>
          Back to GitHub Actions
        </Button>
      </>
    )
  }
  if (error) return <QueryError error={error} onRetry={() => refetch()} />
  if (!data) {
    return (
      <>
        <Skeleton className="h-10 w-80" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-64 w-full" />
      </>
    )
  }

  const { run, jobs } = data
  const runEnd = active ? now : Date.parse(run.updatedAt)

  return (
    <>
      <PageHeader title={run.title} description={`${run.workflow} #${run.runNumber}${run.attempt > 1 ? `, attempt ${run.attempt}` : ""}`}>
        <div className="flex items-center gap-2">
          <ActionStateBadge state={run.state} conclusion={run.conclusion} />
          <Button
            variant="outline"
            nativeButton={false}
            render={<a href={run.url} target="_blank" rel="noreferrer" />}
            data-icon="inline-end"
          >
            Open on GitHub
            <ArrowSquareOutIcon />
          </Button>
        </div>
      </PageHeader>

      <Card>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Field label="Repository">{run.repo}</Field>
            <Field label="Trigger">{run.event.replace(/_/g, " ")}</Field>
            <Field label="Branch"><span className="font-mono text-xs">{run.branch ?? "-"}</span></Field>
            <Field label="Commit"><span className="font-mono text-xs" title={run.sha}>{run.sha.slice(0, 7)}</span></Field>
            <Field label="Actor">
              {run.actor ? (
                <span className="flex items-center gap-2">
                  <Avatar size="sm">
                    <AvatarImage src={run.actor.avatarUrl} alt="" />
                    <AvatarFallback>{run.actor.login.slice(0, 2).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <span className="truncate">{run.actor.login}</span>
                </span>
              ) : (
                "-"
              )}
            </Field>
            <Field label="Started"><Time iso={run.startedAt} /></Field>
            <Field label="Duration"><Elapsed from={run.startedAt} to={active ? null : run.updatedAt} now={now} /></Field>
            <Field label="Queued at"><Time iso={run.createdAt} /></Field>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Jobs</CardTitle>
          <CardDescription>
            {active ? "Live, refreshing every 5 s." : "Bars show when each job ran within the run."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {jobs.length === 0 ? (
            <EmptyState
              title={active ? "No jobs started yet" : "This run has no jobs"}
              hint={active ? "Jobs appear once a runner picks the run up." : undefined}
            />
          ) : (
            <ol className="flex flex-col gap-3">
              {jobs.map((job) => (
                <JobRow key={job.id} job={job} runStart={Date.parse(run.startedAt)} runEnd={runEnd} now={now} />
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </>
  )
}

function JobRow({ job, runStart, runEnd, now }: { job: Job; runStart: number; runEnd: number; now: number }) {
  const span = Math.max(runEnd - runStart, 1)
  const start = job.startedAt ? Date.parse(job.startedAt) : null
  const end = job.completedAt ? Date.parse(job.completedAt) : start !== null ? now : null
  const left = start === null ? 0 : Math.min(Math.max((start - runStart) / span, 0), 1)
  const width = start === null || end === null ? 0 : Math.max((end - start) / span, 0.01)
  const interesting = job.state === "failure" || isActiveState(job.state)

  return (
    <li className={cn("rounded-md border", job.state === "failure" && "border-destructive/40")}>
      <details open={interesting} className="group">
        <summary className="flex cursor-pointer list-none flex-col gap-2 rounded-md p-3 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden">
          <div className="flex items-center gap-2.5">
            <ActionStateIcon state={job.state} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{job.name}</span>
            <span className="text-xs text-muted-foreground">
              <Elapsed from={job.startedAt} to={job.completedAt} now={now} />
            </span>
            {job.url && (
              <a
                href={job.url}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Open job ${job.name} on GitHub`}
                onClick={(event) => event.stopPropagation()}
              >
                <ArrowSquareOutIcon className="size-3.5" />
              </a>
            )}
          </div>
          <div className="relative h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div
              className={cn(
                "absolute inset-y-0 rounded-full transition-[left,width] duration-500 motion-reduce:transition-none",
                job.state === "failure" ? "bg-destructive" : job.state === "running" ? "bg-blue-500" : job.state === "success" ? "bg-emerald-500" : "bg-muted-foreground/40"
              )}
              style={{ left: `${left * 100}%`, width: `${Math.min(width, 1 - left) * 100}%` }}
            />
          </div>
        </summary>
        {job.steps.length > 0 && (
          <ol className="border-t px-3 py-2">
            {job.steps.map((step) => (
              <li
                key={step.number}
                className={cn(
                  "flex items-center gap-2.5 rounded-sm px-1 py-1 text-xs",
                  step.state === "failure" && "bg-destructive/5 font-medium text-destructive"
                )}
              >
                <ActionStateIcon state={step.state} className="size-3.5" />
                <span className="min-w-0 flex-1 truncate">{step.name}</span>
                <span className="text-muted-foreground">
                  {step.state === "skipped" ? "-" : <Elapsed from={step.startedAt} to={step.completedAt ?? (step.state === "running" ? null : step.startedAt)} now={now} />}
                </span>
              </li>
            ))}
          </ol>
        )}
        {job.runner && <p className="border-t px-4 py-2 text-xs text-muted-foreground">Runner {job.runner}</p>}
      </details>
    </li>
  )
}

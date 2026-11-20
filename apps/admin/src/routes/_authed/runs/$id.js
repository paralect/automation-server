import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowCounterClockwiseIcon, FlaskIcon } from "@phosphor-icons/react";
import { canReplay } from "@automation-server/api/replay";
import { DryRunBadge, LevelBadge, StatusBadge } from "@/components/badges";
import { JsonFields } from "@/components/json-fields";
import { EmptyState, PageHeader, QueryError } from "@/components/states";
import { Time } from "@/components/time";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { LEVEL_ROW } from "@/lib/badge-styles";
import { replayRun } from "@/lib/api.functions";
import { errorKind, errorText } from "@/lib/errors";
import { runQuery } from "@/lib/queries";
import { wouldDo } from "@/lib/would-do";
import { useProjectId } from "@/lib/project";
import { formatDuration } from "@/lib/time";
export const Route = createFileRoute("/_authed/runs/$id")({ component: RunDetail });
function Field({ label, children }) {
    return (<div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm break-all">{children}</dd>
    </div>);
}
function RunDetail() {
    const { id } = Route.useParams();
    const project = useProjectId();
    const { data, error, refetch } = useQuery(runQuery(project, id));
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const replay = useMutation({
        mutationFn: (dryRun) => replayRun({ data: { project, id, dryRun } }),
        onSuccess: ({ runId }) => {
            void queryClient.invalidateQueries({ queryKey: [project, "runs"] });
            void queryClient.invalidateQueries({ queryKey: [project, "run"] });
            void navigate({ to: "/runs/$id", params: { id: runId } });
        },
    });
    if (error && errorKind(error) === "not-found") {
        return (<>
        <EmptyState title="Run not found" hint={`No run with id ${id}. It may have been pruned by retention.`}/>
        <Button variant="outline" className="self-center" nativeButton={false} render={<Link to="/runs"/>}>
          Back to runs
        </Button>
      </>);
    }
    if (error)
        return <QueryError error={error} onRetry={() => refetch()}/>;
    if (!data) {
        return (<>
        <Skeleton className="h-32 w-full"/>
        <Skeleton className="h-64 w-full"/>
      </>);
    }
    const { run, logs, event } = data;
    const replayable = canReplay(run);
    const dryReplayable = canReplay(run, { dryRun: true });
    const planned = wouldDo(run.outcome);
    const replaying = replay.isPending && replay.variables === false;
    const dryRunning = replay.isPending && replay.variables === true;
    return (<>
      <PageHeader title={run.automation} description={`Run ${run.id}`}>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={run.status}/>
          {run.dryRun && <DryRunBadge />}
          <Button variant="outline" size="sm" disabled={!replayable.ok || replay.isPending} title={replayable.ok ? undefined : replayable.reason} onClick={() => replay.mutate(false)}>
            <ArrowCounterClockwiseIcon data-icon="inline-start"/>
            {replaying ? "Replaying..." : "Replay"}
          </Button>
          <Button variant="outline" size="sm" disabled={!dryReplayable.ok || replay.isPending} title={dryReplayable.ok ? "Re-run this event, reading but writing nothing" : dryReplayable.reason} onClick={() => replay.mutate(true)}>
            <FlaskIcon data-icon="inline-start"/>
            {dryRunning ? "Starting..." : "Dry run"}
          </Button>
        </div>
      </PageHeader>
      {!replayable.ok && <p className="-mt-3 text-xs text-muted-foreground">{replayable.reason}</p>}
      {replayable.ok === false && dryReplayable.ok === false && dryReplayable.reason !== replayable.reason && (<p className="-mt-3 text-xs text-muted-foreground">Dry run: {dryReplayable.reason}</p>)}
      {replay.error && (<p role="alert" className="-mt-3 text-xs text-destructive">
          {errorText(replay.error)}
        </p>)}

      <Card>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Field label="Source">{run.source}</Field>
            <Field label="Kind">{run.kind}</Field>
            <Field label="External ID"><span className="font-mono text-xs">{run.externalId}</span></Field>
            <Field label="Duration">{formatDuration(run.startedAt, run.finishedAt)}</Field>
            <Field label="Started"><Time iso={run.startedAt}/></Field>
            <Field label="Finished">{run.finishedAt ? <Time iso={run.finishedAt}/> : "-"}</Field>
            {run.replayOf && (<Field label="Replay of">
                <Link to="/runs/$id" params={{ id: run.replayOf }} className="font-mono text-xs underline underline-offset-2">
                  {run.replayOf}
                </Link>
              </Field>)}
          </dl>
          {run.error && (<p role="alert" className="mt-4 rounded-md bg-destructive/10 p-3 font-mono text-xs break-words whitespace-pre-wrap text-destructive">
              {run.error}
            </p>)}
        </CardContent>
      </Card>

      {planned.length > 0 && (<Card>
          <CardHeader>
            <CardTitle>Would have done</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-2 text-xs text-muted-foreground">This was a dry run. Nothing below was written.</p>
            <ul className="flex flex-col gap-3 text-sm">
              {planned.map((action) => (<li key={action.kind}>
                  <p>{action.text}</p>
                  {action.detail && (<pre className="mt-1 rounded-md bg-muted p-3 text-xs/relaxed break-words whitespace-pre-wrap text-muted-foreground">
                      {action.detail}
                    </pre>)}
                </li>))}
            </ul>
          </CardContent>
        </Card>)}

      {event && (<Card>
          <CardHeader>
            <CardTitle>Event</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-2 text-xs text-muted-foreground">
              The event as received, with secret-looking values redacted. Replay runs from this.
            </p>
            <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-all">
              {JSON.stringify(event, null, 2)}
            </pre>
          </CardContent>
        </Card>)}

      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          {logs.length === 0 ? (<EmptyState title="No log entries for this run"/>) : (<ol className="flex flex-col gap-2">
              {[...logs].sort((a, b) => a.id - b.id).map((log) => (<li key={log.id} className={`rounded-md border p-3 ${LEVEL_ROW[log.level]}`}>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <LevelBadge level={log.level}/>
                    <Time iso={log.time}/>
                  </div>
                  <p className="mt-1 text-sm break-words">{log.message}</p>
                  <JsonFields fields={log.fields}/>
                </li>))}
            </ol>)}
        </CardContent>
      </Card>
    </>);
}

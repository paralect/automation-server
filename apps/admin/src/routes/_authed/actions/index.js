import { useCallback } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowClockwiseIcon, ArrowSquareOutIcon, GitBranchIcon, WarningIcon } from "@phosphor-icons/react";
import { ActionStateIcon, Elapsed, useNow } from "@/components/action-state";
import { EnumFilter } from "@/components/filters";
import { EmptyState, PageHeader, QueryError, RowsSkeleton } from "@/components/states";
import { Time } from "@/components/time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ACTION_STATES, actionsSearch } from "@/lib/filters";
import { actionRunsQuery, isActiveState } from "@/lib/queries";
import { useProjectId } from "@/lib/project";
import { formatRelative } from "@/lib/time";
export const Route = createFileRoute("/_authed/actions/")({
    validateSearch: actionsSearch,
    component: Actions,
});
function Actions() {
    const filters = Route.useSearch();
    const navigate = Route.useNavigate();
    const update = useCallback((patch) => navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true }), [navigate]);
    const query = useInfiniteQuery(actionRunsQuery(useProjectId(), filters));
    const pages = query.data?.pages ?? [];
    const first = pages[0];
    const runs = pages.flatMap((page) => page.runs);
    const errors = first?.errors ?? [];
    const active = runs.filter((run) => isActiveState(run.state)).length;
    const now = useNow(true, active > 0 ? 1000 : 15_000);
    return (<>
      <PageHeader title="GitHub Actions" description={first ? `Workflow runs in ${first.repos.join(", ")}` : "Workflow runs in the tracked repositories."}>
        <div className="flex items-center gap-3">
          {query.data && (<p className="text-xs text-muted-foreground" aria-live="polite">
              {active > 0 ? (<span className="font-medium text-blue-600 dark:text-blue-400">
                  {active} in progress, refreshing every 5 s
                </span>) : (`Updated ${formatRelative(new Date(query.dataUpdatedAt).toISOString(), Math.max(now, query.dataUpdatedAt))}`)}
            </p>)}
          <Button variant="outline" size="icon" aria-label="Refresh" onClick={() => query.refetch()} disabled={query.isFetching}>
            <ArrowClockwiseIcon className={query.isFetching ? "motion-safe:animate-spin" : undefined}/>
          </Button>
        </div>
      </PageHeader>

      <div className="flex flex-wrap gap-2">
        {first && first.repos.length > 1 && (<EnumFilter label="Repository" value={filters.repo} options={first.repos} onChange={(repo) => update({ repo })}/>)}
        <EnumFilter label="Workflow" value={filters.workflow} options={first?.workflows ?? (filters.workflow ? [filters.workflow] : [])} onChange={(workflow) => update({ workflow })}/>
        <EnumFilter label="State" value={filters.state} options={ACTION_STATES} onChange={(state) => update({ state })}/>
      </div>

      {errors.map((error) => (<Alert key={error.repo} role="alert">
          <WarningIcon />
          <AlertTitle>Could not read {error.repo}</AlertTitle>
          <AlertDescription>
            {error.message}. Runs from the other repositories are still shown.
          </AlertDescription>
        </Alert>))}

      {query.error ? (<QueryError error={query.error} onRetry={() => query.refetch()}/>) : query.isPending ? (<RowsSkeleton />) : runs.length === 0 ? (<EmptyState title="No workflow runs" hint={filters.workflow || filters.state || filters.repo
                ? "Nothing matches these filters."
                : "Runs appear here as soon as a workflow starts in a tracked repository."}/>) : (<>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-full min-w-72">Run</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>
                    <span className="sr-only">GitHub</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (<TableRow key={`${run.repo}:${run.id}`}>
                    <TableCell className="max-w-0">
                      <div className="flex items-start gap-2.5">
                        <span className="mt-0.5" title={run.conclusion ?? run.state}>
                          <ActionStateIcon state={run.state}/>
                          <span className="sr-only">{run.state}</span>
                        </span>
                        <div className="min-w-0">
                          <Link to="/actions/$id" params={{ id: String(run.id) }} search={{ repo: run.repo }} className="block truncate font-medium underline-offset-4 hover:underline focus-visible:underline" title={run.title}>
                            {run.title}
                          </Link>
                          <p className="truncate text-xs text-muted-foreground">
                            {run.workflow} #{run.runNumber}
                            {run.attempt > 1 && `, attempt ${run.attempt}`}
                            {first && first.repos.length > 1 && <span className="ml-2">{run.repo}</span>}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">
                      <div>{run.event.replace(/_/g, " ")}</div>
                      {run.branch && (<div className="flex max-w-40 items-center gap-1 text-muted-foreground">
                          <GitBranchIcon className="size-3 shrink-0" aria-hidden/>
                          <span className="truncate font-mono" title={run.branch}>{run.branch}</span>
                        </div>)}
                    </TableCell>
                    <TableCell>
                      {run.actor ? (<div className="flex items-center gap-2 text-xs">
                          <Avatar size="sm">
                            <AvatarImage src={run.actor.avatarUrl} alt=""/>
                            <AvatarFallback>{run.actor.login.slice(0, 2).toUpperCase()}</AvatarFallback>
                          </Avatar>
                          <span className="max-w-28 truncate">{run.actor.login}</span>
                        </div>) : (<span className="text-xs text-muted-foreground">-</span>)}
                    </TableCell>
                    <TableCell className="text-xs"><Time iso={run.startedAt}/></TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      <Elapsed from={run.startedAt} to={isActiveState(run.state) ? null : run.updatedAt} now={now}/>
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon-sm" nativeButton={false} render={<a href={run.url} target="_blank" rel="noreferrer"/>} aria-label={`Open run ${run.runNumber} on GitHub`}>
                        <ArrowSquareOutIcon />
                      </Button>
                    </TableCell>
                  </TableRow>))}
              </TableBody>
            </Table>
          </div>
          {query.hasNextPage && (<Button variant="outline" className="self-center" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
              {query.isFetchingNextPage ? "Loading..." : "Load more"}
            </Button>)}
        </>)}
    </>);
}

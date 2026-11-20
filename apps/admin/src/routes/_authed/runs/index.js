import { useCallback } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { DryRunBadge, StatusBadge } from "@/components/badges";
import { EnumFilter, TextFilter } from "@/components/filters";
import { EmptyState, PageHeader, QueryError, RowsSkeleton } from "@/components/states";
import { Time } from "@/components/time";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DRY_RUN_FILTERS, RUN_STATUSES, runsSearch } from "@/lib/filters";
import { runsQuery, systemQuery } from "@/lib/queries";
import { useProjectId } from "@/lib/project";
import { formatDuration } from "@/lib/time";
export const Route = createFileRoute("/_authed/runs/")({
    validateSearch: runsSearch,
    component: Runs,
});
function Runs() {
    const filters = Route.useSearch();
    const navigate = Route.useNavigate();
    const update = useCallback((patch) => navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true }), [navigate]);
    const setSource = useCallback((source) => update({ source }), [update]);
    const setAutomation = useCallback((automation) => update({ automation }), [update]);
    const setQ = useCallback((q) => update({ q }), [update]);
    const project = useProjectId();
    const system = useQuery(systemQuery(project));
    const query = useInfiniteQuery(runsQuery(project, filters));
    const runs = query.data?.pages.flatMap((page) => page.items) ?? [];
    return (<>
      <PageHeader title="Runs" description="Every automation run, newest first."/>

      <div className="flex flex-wrap gap-2">
        <EnumFilter label="Status" value={filters.status} options={RUN_STATUSES} onChange={(status) => update({ status })}/>
        <EnumFilter label="Dry runs" value={filters.dryRun} options={DRY_RUN_FILTERS} onChange={(dryRun) => update({ dryRun })}/>
        <TextFilter label="Automation" value={filters.automation} suggestions={system.data?.automations} onChange={setAutomation}/>
        <TextFilter label="Source" value={filters.source} suggestions={system.data?.sources} onChange={setSource}/>
        <TextFilter label="Search" value={filters.q} onChange={setQ} className="w-56"/>
      </div>

      {query.error ? (<QueryError error={query.error} onRetry={() => query.refetch()}/>) : query.isPending ? (<RowsSkeleton />) : runs.length === 0 ? (<EmptyState title="No runs" hint="Nothing matches these filters yet."/>) : (<>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Automation</TableHead>
                  <TableHead>Source / kind</TableHead>
                  <TableHead>External ID</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (<TableRow key={run.id}>
                    <TableCell>
                      <Link to="/runs/$id" params={{ id: run.id }} className="underline-offset-4 hover:underline focus-visible:underline">
                        <StatusBadge status={run.status}/>
                        <span className="sr-only"> open run</span>
                      </Link>
                      {run.dryRun && (<span className="ml-1.5">
                          <DryRunBadge />
                        </span>)}
                    </TableCell>
                    <TableCell>{run.automation}</TableCell>
                    <TableCell className="text-xs">
                      <div>{run.source}</div>
                      <div className="text-muted-foreground">{run.kind}</div>
                    </TableCell>
                    <TableCell className="max-w-48 truncate font-mono text-xs" title={run.externalId}>{run.externalId}</TableCell>
                    <TableCell className="text-xs"><Time iso={run.startedAt}/></TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{formatDuration(run.startedAt, run.finishedAt)}</TableCell>
                    <TableCell className="max-w-64 truncate text-xs text-destructive" title={run.error ?? undefined}>{run.error}</TableCell>
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

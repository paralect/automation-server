import { useCallback, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { LevelBadge } from "@/components/badges";
import { EnumFilter, TextFilter } from "@/components/filters";
import { JsonFields } from "@/components/json-fields";
import { EmptyState, PageHeader, QueryError, RowsSkeleton } from "@/components/states";
import { Time } from "@/components/time";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LEVEL_ROW } from "@/lib/badge-styles";
import { LOG_LEVELS, logsSearch } from "@/lib/filters";
import { logsQuery as logsQueryOptions, systemQuery } from "@/lib/queries";
import { useProjectId } from "@/lib/project";
export const Route = createFileRoute("/_authed/logs")({
    validateSearch: logsSearch,
    component: Logs,
});
function Logs() {
    const filters = Route.useSearch();
    const navigate = Route.useNavigate();
    const [live, setLive] = useState(false);
    const update = useCallback((patch) => navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true }), [navigate]);
    const setSource = useCallback((source) => update({ source }), [update]);
    const setAutomation = useCallback((automation) => update({ automation }), [update]);
    const setRunId = useCallback((runId) => update({ runId }), [update]);
    const setQ = useCallback((q) => update({ q }), [update]);
    const project = useProjectId();
    const system = useQuery(systemQuery(project));
    const query = useInfiniteQuery(logsQueryOptions(project, filters, live));
    const logs = query.data?.pages.flatMap((page) => page.items) ?? [];
    return (<>
      <PageHeader title="Logs" description="Everything the server logged, newest first.">
        <div className="flex items-center gap-2">
          <Switch id="live" checked={live} onCheckedChange={setLive}/>
          <Label htmlFor="live">Live (every 5s)</Label>
        </div>
      </PageHeader>

      <div className="flex flex-wrap gap-2">
        <EnumFilter label="Level" value={filters.level} options={LOG_LEVELS} onChange={(level) => update({ level })}/>
        <TextFilter label="Source" value={filters.source} suggestions={system.data?.sources} onChange={setSource}/>
        <TextFilter label="Automation" value={filters.automation} suggestions={system.data?.automations} onChange={setAutomation}/>
        <TextFilter label="Run ID" value={filters.runId} onChange={setRunId}/>
        <TextFilter label="Search messages" value={filters.q} onChange={setQ} className="w-56"/>
      </div>

      {query.error ? (<QueryError error={query.error} onRetry={() => query.refetch()}/>) : query.isPending ? (<RowsSkeleton />) : logs.length === 0 ? (<EmptyState title="No log entries" hint="Nothing matches these filters yet."/>) : (<>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-48">Time</TableHead>
                  <TableHead className="w-20">Level</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead className="w-44">Source / automation</TableHead>
                  <TableHead className="w-20">Run</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log) => (<TableRow key={log.id} className={LEVEL_ROW[log.level]}>
                    <TableCell className="align-top text-xs"><Time iso={log.time}/></TableCell>
                    <TableCell className="align-top"><LevelBadge level={log.level}/></TableCell>
                    <TableCell className="align-top whitespace-normal">
                      <span className="break-words">{log.message}</span>
                      <JsonFields fields={log.fields}/>
                    </TableCell>
                    <TableCell className="align-top text-xs whitespace-normal">
                      <div>{log.source ?? "-"}</div>
                      <div className="text-muted-foreground">{log.automation}</div>
                    </TableCell>
                    <TableCell className="align-top text-xs">
                      {log.runId && (<Link to="/runs/$id" params={{ id: log.runId }} className="font-mono underline underline-offset-4">
                          {log.runId.slice(0, 8)}
                        </Link>)}
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

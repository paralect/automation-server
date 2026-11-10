import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { PageHeader, QueryError } from "@/components/states"
import { Time } from "@/components/time"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { ERROR_COPY, errorKind } from "@/lib/errors"
import { systemQuery } from "@/lib/queries"
import { formatUptime } from "@/lib/time"

export const Route = createFileRoute("/_authed/system")({ component: System })

function Names({ names }: { names: string[] }) {
  return names.length === 0 ? (
    <span className="text-sm text-muted-foreground">None registered</span>
  ) : (
    <ul className="flex flex-wrap gap-2">
      {names.map((name) => (
        <li key={name}><Badge variant="outline">{name}</Badge></li>
      ))}
    </ul>
  )
}

function System() {
  const { data, error, isPending, refetch } = useQuery(systemQuery())

  const backend = error
    ? { label: ERROR_COPY[errorKind(error)].title, variant: "destructive" as const }
    : isPending
      ? null
      : { label: "Reachable", variant: "secondary" as const }

  return (
    <>
      <PageHeader title="System" description="State of the automation server.">
        {backend && <Badge variant={backend.variant}>{backend.label}</Badge>}
      </PageHeader>

      {error ? (
        <QueryError error={error} onRetry={() => refetch()} />
      ) : !data ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Card size="sm">
              <CardHeader>
                <CardDescription>Uptime</CardDescription>
                <CardTitle className="text-2xl tabular-nums">{formatUptime(data.uptimeSeconds)}</CardTitle>
              </CardHeader>
            </Card>
            <Card size="sm">
              <CardHeader>
                <CardDescription>Started at</CardDescription>
                <CardTitle className="text-base"><Time iso={data.startedAt} /></CardTitle>
              </CardHeader>
            </Card>
            <Card size="sm">
              <CardHeader>
                <CardDescription>Log and run retention</CardDescription>
                <CardTitle className="text-2xl tabular-nums">{data.retentionDays} days</CardTitle>
              </CardHeader>
            </Card>
          </div>
          <Card>
            <CardHeader><CardTitle>Sources</CardTitle></CardHeader>
            <CardContent><Names names={data.sources} /></CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Automations</CardTitle></CardHeader>
            <CardContent><Names names={data.automations} /></CardContent>
          </Card>
        </>
      )}
    </>
  )
}

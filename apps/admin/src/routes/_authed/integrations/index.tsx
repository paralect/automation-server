import { useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { CaretRightIcon, PlusIcon, WarningIcon } from "@phosphor-icons/react"
import type { IntegrationView } from "@automation-server/api/routers/index"

import { IntegrationLogo, StatusDot, type DotTone } from "@/components/integration-card"
import { isAdded } from "@/lib/integration-workflows"
import { EmptyState, PageHeader, QueryError } from "@/components/states"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { integrationStatus, type IntegrationStatus } from "@/lib/health"
import { settingsQuery } from "@/lib/queries"
import { useProjectId } from "@/lib/project"

export const Route = createFileRoute("/_authed/integrations/")({ component: Integrations })

function Integrations() {
  const settings = useQuery(settingsQuery(useProjectId()))
  const navigate = useNavigate()
  const [picking, setPicking] = useState(false)

  const integrations = settings.data?.integrations ?? []
  const shown = integrations.filter(isAdded)
  const available = integrations.filter((i) => !isAdded(i))

  const pick = (id: string) => {
    setPicking(false)
    void navigate({ to: "/integrations/$id", params: { id } })
  }

  return (
    <>
      <PageHeader title="Integrations" description="Connected services. Saving settings applies them without a restart.">
        <Button onClick={() => setPicking(true)} disabled={!settings.data || available.length === 0}>
          <PlusIcon />
          Add integration
        </Button>
      </PageHeader>

      {settings.error ? (
        <QueryError error={settings.error} onRetry={() => settings.refetch()} />
      ) : !settings.data ? (
        <div className="flex max-w-3xl flex-col gap-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : (
        <>
          {!settings.data.secretsWritable && (
            <Alert>
              <WarningIcon />
              <AlertTitle>Secrets are read-only</AlertTitle>
              <AlertDescription>
                Set SETTINGS_ENCRYPTION_KEY on the server to save tokens and secrets here. Other fields still save.
              </AlertDescription>
            </Alert>
          )}
          {shown.length === 0 ? (
            <EmptyState title="No integrations yet" hint="Use Add integration to connect GitHub, Sentry, Linear or PostHog." />
          ) : (
            <IntegrationRows integrations={shown} />
          )}
        </>
      )}

      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add integration</DialogTitle>
            <DialogDescription>Pick a service, then enter its settings.</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-2">
            {available.map((integration) => (
              <AvailableIntegration key={integration.id} integration={integration} onPick={() => pick(integration.id)} />
            ))}
          </DialogBody>
        </DialogContent>
      </Dialog>

    </>
  )
}

function AvailableIntegration({ integration, onPick }: { integration: IntegrationView; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex items-center gap-3 rounded-lg p-3 text-left ring-1 ring-foreground/10 transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <IntegrationLogo id={integration.id} />
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-medium">{integration.title}</span>
        <span className="text-xs text-muted-foreground">{integration.description}</span>
      </span>
    </button>
  )
}

type Row = { integration: IntegrationView; status: IntegrationStatus }

function IntegrationRows({ integrations }: { integrations: readonly IntegrationView[] }) {
  const now = new Date()
  const rows = integrations.map((integration): Row => ({ integration, status: integrationStatus(integration, now) }))
  const groups = [
    { title: "Needs attention", rows: rows.filter((r) => r.status.kind === "attention") },
    { title: "Connected", rows: rows.filter((r) => r.status.kind !== "attention") },
  ].filter((g) => g.rows.length > 0)

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      {groups.map((group) => (
        <section key={group.title} aria-label={group.title} className="flex flex-col gap-2">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {group.title} · {group.rows.length}
          </h2>
          <ul className="divide-y overflow-hidden rounded-lg bg-card ring-1 ring-foreground/10">
            {group.rows.map((row) => (
              <li key={row.integration.id}>
                <IntegrationRow {...row} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

const STATUS: Record<IntegrationStatus["kind"], { tone: DotTone; label: string }> = {
  attention: { tone: "warn", label: "Needs attention" },
  healthy: { tone: "ok", label: "Healthy" },
  unchecked: { tone: "unknown", label: "Not checked yet" },
}

function IntegrationRow({ integration, status }: Row) {
  const { tone, label } = STATUS[status.kind]
  return (
    <Link
      to="/integrations/$id"
      params={{ id: integration.id }}
      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <IntegrationLogo id={integration.id} className="size-9 p-1.5" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">{integration.title}</span>
        <span className="truncate text-xs text-muted-foreground">
          {status.kind === "attention" ? status.reason : integration.description}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <StatusDot tone={tone} label={label} />
        <span className="hidden sm:inline">{label}</span>
        <CaretRightIcon className="size-3.5" />
      </span>
    </Link>
  )
}

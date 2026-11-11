import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { PlusIcon, WarningIcon } from "@phosphor-icons/react"
import type { IntegrationView } from "@automation-server/api/routers/index"

import { IntegrationCard, IntegrationLogo, IntegrationSettings, isAdded } from "@/components/integration-card"
import { EmptyState, PageHeader, QueryError } from "@/components/states"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { settingsQuery, systemQuery } from "@/lib/queries"

export const Route = createFileRoute("/_authed/integrations")({ component: Integrations })

function Integrations() {
  const settings = useQuery(settingsQuery())
  const system = useQuery(systemQuery())
  const [picking, setPicking] = useState(false)
  const [openId, setOpenId] = useState<string>()
  // An integration picked from the add dialog stays on the page while its first settings are entered.
  const [pickedIds, setPickedIds] = useState<ReadonlySet<string>>(new Set())

  const integrations = settings.data?.integrations ?? []
  const shown = integrations.filter((i) => isAdded(i) || pickedIds.has(i.id))
  const available = integrations.filter((i) => !shown.includes(i))
  const open = integrations.find((i) => i.id === openId)

  const pick = (id: string) => {
    setPickedIds((prev) => new Set(prev).add(id))
    setPicking(false)
    setOpenId(id)
  }
  const closeSettings = () => {
    if (open && !isAdded(open)) {
      setPickedIds((prev) => {
        const next = new Set(prev)
        next.delete(open.id)
        return next
      })
    }
    setOpenId(undefined)
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
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
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
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {shown.map((integration) => (
                <IntegrationCard key={integration.id} integration={integration} onOpen={() => setOpenId(integration.id)} />
              ))}
            </div>
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

      <Dialog open={open !== undefined} onOpenChange={(next) => !next && closeSettings()}>
        <DialogContent className="max-w-xl">
          {open && settings.data && (
            <IntegrationSettings
              // Remount when the saved view changes so the form starts from the new values.
              key={`${open.id}:${JSON.stringify(open.fields)}`}
              integration={open}
              secretsWritable={settings.data.secretsWritable}
              webhookUrl={open.webhookSource ? system.data?.webhookUrls[open.webhookSource] : undefined}
            />
          )}
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

import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { WarningIcon } from "@phosphor-icons/react"

import { IntegrationCard } from "@/components/integration-card"
import { PageHeader, QueryError } from "@/components/states"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { settingsQuery, systemQuery } from "@/lib/queries"

export const Route = createFileRoute("/_authed/integrations")({ component: Integrations })

function Integrations() {
  const settings = useQuery(settingsQuery())
  const system = useQuery(systemQuery())

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Credentials and options for each integration. Saving applies them without a restart."
      />

      {settings.error ? (
        <QueryError error={settings.error} onRetry={() => settings.refetch()} />
      ) : !settings.data ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <Skeleton className="h-96 w-full" />
          <Skeleton className="h-96 w-full" />
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
          <div className="grid items-start gap-4 xl:grid-cols-2">
            {settings.data.integrations.map((integration) => (
              <IntegrationCard
                // Remount when this integration's saved view changes so the form starts from the new values.
                key={`${integration.id}:${JSON.stringify(integration.fields)}`}
                integration={integration}
                secretsWritable={settings.data.secretsWritable}
                webhookUrl={integration.webhookSource ? system.data?.webhookUrls[integration.webhookSource] : undefined}
              />
            ))}
          </div>
        </>
      )}
    </>
  )
}

import { Link, createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { ArrowLeftIcon } from "@phosphor-icons/react"

import { IntegrationSettings } from "@/components/integration-settings"
import { EmptyState, QueryError } from "@/components/states"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { templateFor } from "@/lib/integration-workflows"
import { settingsQuery, systemQuery, workflowTemplatesQuery } from "@/lib/queries"
import { useProjectId } from "@/lib/project"

export const Route = createFileRoute("/_authed/integrations/$id")({ component: IntegrationPage })

function IntegrationPage() {
  const { id } = Route.useParams()
  const project = useProjectId()
  const settings = useQuery(settingsQuery(project))
  const system = useQuery(systemQuery(project))
  const templates = useQuery(workflowTemplatesQuery())

  const back = (
    <Button variant="ghost" size="sm" className="self-start" nativeButton={false} render={<Link to="/integrations" />}>
      <ArrowLeftIcon />
      All integrations
    </Button>
  )

  if (settings.error) return <QueryError error={settings.error} onRetry={() => settings.refetch()} />
  if (!settings.data) {
    return (
      <>
        <Skeleton className="h-12 w-72" />
        <Skeleton className="h-96 w-full max-w-2xl" />
      </>
    )
  }

  const integration = settings.data.integrations.find((i) => i.id === id)
  if (!integration) {
    return (
      <>
        <EmptyState title="Integration not found" hint={`There is no integration called ${id}.`} />
        {back}
      </>
    )
  }

  return (
    <>
      {back}
      <IntegrationSettings
        // Remount when the saved view changes so the form starts from the new values.
        key={`${integration.id}:${JSON.stringify(integration.fields)}`}
        integration={integration}
        integrations={settings.data.integrations}
        workflow={templateFor(integration.id, templates.data)}
        secretsWritable={settings.data.secretsWritable}
        webhookUrl={integration.webhookSource ? system.data?.webhookUrls[integration.webhookSource] : undefined}
      />
    </>
  )
}

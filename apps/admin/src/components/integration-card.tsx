import { Link } from "@tanstack/react-router"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { GearSixIcon, PlugIcon } from "@phosphor-icons/react"
import { cn } from "cn"
import type { IntegrationView } from "@automation-server/api/routers/index"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { FieldError } from "@/components/ui/field"
import { Time } from "@/components/time"
import { testConnection } from "@/lib/api.functions"
import { errorText } from "@/lib/errors"
import { expiryLabel, expiryState, healthDot, type HealthDot } from "@/lib/health"
import { settingsQuery } from "@/lib/queries"
import { useProjectId } from "@/lib/project"
import { missingText } from "@/lib/settings-form"

const LOGOS: Record<string, string> = {
  github: "/integrations/github.svg",
  sentry: "/integrations/sentry.svg",
  linear: "/integrations/linear.svg",
  posthog: "/integrations/posthog.svg",
  crisp: "/integrations/crisp.svg",
  slack: "/integrations/slack.svg",
}

// A white tile keeps every brand mark in its official colors on both themes.
export function IntegrationLogo({ id, className }: { id: string; className?: string }) {
  const src = LOGOS[id]
  return (
    <div className={cn("flex size-10 shrink-0 items-center justify-center rounded-lg bg-white p-2 ring-1 ring-foreground/10", className)}>
      {src ? <img src={src} alt="" className="max-h-full max-w-full object-contain" /> : <PlugIcon className="size-5 text-neutral-500" />}
    </div>
  )
}

export function StatusBadge({ integration }: { integration: IntegrationView }) {
  return integration.configured ? (
    <Badge variant="secondary">Configured</Badge>
  ) : (
    <Badge variant="outline">Needs setup</Badge>
  )
}

export type DotTone = "ok" | "warn" | "failed" | "unknown"

const DOT_CLASS: Record<DotTone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  failed: "bg-red-500",
  unknown: "bg-neutral-400",
}

export function StatusDot({ tone, label }: { tone: DotTone; label: string }) {
  return <span role="img" aria-label={label} title={label} className={cn("size-2 shrink-0 rounded-full", DOT_CLASS[tone])} />
}

const DOT_LABEL: Record<HealthDot, string> = {
  ok: "Healthy",
  failed: "Failing",
  unknown: "Not checked yet",
}

export function HealthSummary({ health }: { health: IntegrationView["health"] }) {
  const dot = healthDot(health)
  const expiry = expiryState(health?.expiresAt, new Date())
  const label = expiryLabel(expiry)
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <StatusDot tone={dot} label={DOT_LABEL[dot]} />
        {health ? (
          <>
            Checked <Time iso={health.checkedAt} relativeOnly />
          </>
        ) : (
          DOT_LABEL[dot]
        )}
      </span>
      {label && (
        <Badge
          variant={expiry.kind === "expired" ? "destructive" : "outline"}
          className={cn(expiry.kind === "expiring" && expiry.warning && "bg-amber-500/15 text-amber-700 dark:text-amber-400")}
        >
          {label}
        </Badge>
      )}
    </div>
  )
}

export function IntegrationCard({ integration }: { integration: IntegrationView }) {
  const queryClient = useQueryClient()
  const project = useProjectId()
  const test = useMutation({
    mutationFn: () => testConnection({ data: { project, integrationId: integration.id } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: settingsQuery(project).queryKey }),
  })
  const missing = missingText(integration.missing, integration.fields)
  return (
    <Card className="transition-shadow hover:ring-foreground/20">
      <CardHeader>
        <div className="flex items-center gap-3">
          <IntegrationLogo id={integration.id} />
          <CardTitle className="text-sm">{integration.title}</CardTitle>
        </div>
        <CardAction>
          <StatusBadge integration={integration} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-2">
        <CardDescription>{integration.description}</CardDescription>
        {!integration.configured && missing && <p className="text-xs text-muted-foreground">{missing}</p>}
        {integration.configured && <HealthSummary health={integration.health} />}
        {test.error ? (
          <FieldError>{errorText(test.error)}</FieldError>
        ) : (
          test.data && <p role="status" className={cn("text-xs", !test.data.ok && "text-destructive")}>{test.data.message}</p>
        )}
      </CardContent>
      <CardFooter className="gap-2">
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<Link to="/integrations/$id" params={{ id: integration.id }} />}
        >
          <GearSixIcon />
          Configure
        </Button>
        {integration.configured && (
          <Button variant="ghost" size="sm" onClick={() => test.mutate()} disabled={test.isPending}>
            {test.isPending ? "Testing..." : "Test"}
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}

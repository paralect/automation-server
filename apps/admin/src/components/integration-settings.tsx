import { Fragment, useState, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { CaretRightIcon, CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react"
import { cn } from "cn"
import type { ConnectionTestResult, FieldView, IntegrationView } from "@automation-server/api/routers/index"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { FieldError } from "@/components/ui/field"
import { HealthSummary, IntegrationLogo, StatusBadge, StatusDot } from "@/components/integration-card"
import { FieldControls, useFieldForm, WebhookUrl, WebhookUrlValue, type FieldForm } from "@/components/integration-fields"
import { IntegrationWorkflow } from "@/components/integration-workflow"
import { SlackIdBadges } from "@/components/slack-picker"
import { previewPosthogReport, runPosthogNow, testConnection, updateSettings } from "@/lib/api.functions"
import { errorText } from "@/lib/errors"
import { advancedSummary, displayValue, sectionsOf, type Section } from "@/lib/integration-sections"
import { fieldOf, isGithubReady, savedRepo, type LinkedTemplate } from "@/lib/integration-workflows"
import { settingsQuery, slackDirectoryKey, systemQuery } from "@/lib/queries"
import { useProjectId } from "@/lib/project"
import { buildPayload, isDirty, missingText } from "@/lib/settings-form"
import { pickerKindOf, pickersEnabled } from "@/lib/slack-picker"

type Mode = { kind: "setup" } | { kind: "view" } | { kind: "edit"; section: string }

type Props = {
  integration: IntegrationView
  integrations: readonly IntegrationView[]
  workflow: LinkedTemplate | undefined
  secretsWritable: boolean
  webhookUrl: string | undefined
}

export function IntegrationSettings({ integration, integrations, workflow, secretsWritable, webhookUrl }: Props) {
  const queryClient = useQueryClient()
  const project = useProjectId()
  const { id, fields } = integration
  const [mode, setMode] = useState<Mode>(integration.configured ? { kind: "view" } : { kind: "setup" })
  const form = useFieldForm(fields)
  const [formError, setFormError] = useState<string>()

  const save = useMutation({
    mutationFn: (payload: { values: Record<string, unknown>; clear: string[] }) =>
      updateSettings({ data: { project, integrationId: id, ...payload } }),
    onSuccess: (view) => {
      queryClient.setQueryData(settingsQuery(project).queryKey, view)
      void queryClient.invalidateQueries({ queryKey: systemQuery(project).queryKey })
      void queryClient.invalidateQueries({ queryKey: settingsQuery(project).queryKey })
      // A new token may open another workspace, so the lists read with the old one are stale.
      if (id === "slack") for (const kind of ["users", "channels"] as const) void queryClient.invalidateQueries({ queryKey: slackDirectoryKey(project, kind) })
    },
  })
  const test = useMutation({
    mutationFn: () => testConnection({ data: { project, integrationId: id } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: settingsQuery(project).queryKey }),
  })

  // A save that changes the saved view remounts this component (the route keys it on the fields), which lands in view mode. onSaved covers a save that changes nothing visible, such as a replaced secret.
  const submit = (scope: readonly FieldView[], onSaved: () => void) => {
    const built = buildPayload(scope, form.state, form.secretActions)
    if (!built.ok) {
      setFormError(built.error)
      return
    }
    setFormError(undefined)
    save.mutate(built.payload, { onSuccess: onSaved })
  }
  const close = (section: Section) => {
    form.reset(section.fields.map((f) => f.key))
    setFormError(undefined)
    save.reset()
    setMode({ kind: "view" })
  }

  const sections = sectionsOf(fields)
  const error = formError ?? (save.error ? errorText(save.error) : undefined)
  const pickers = pickersEnabled(fields)
  const webhook = integration.webhookSource && webhookUrl ? { url: webhookUrl, title: integration.title } : undefined
  const extras = (
    <>
      {workflow && (
        <div className="p-4">
          <IntegrationWorkflow
            template={workflow}
            repo={savedRepo(workflow, integrations)}
            repoLabel={repoLabelOf(workflow, integrations, id)}
            githubReady={isGithubReady(integrations)}
            className="rounded-none border-0 p-0"
          />
        </div>
      )}
      {id === "posthog" && <PosthogActions />}
    </>
  )
  const controls = (section: Section) => (
    <FieldControls integrationId={id} fields={section.fields} form={form} pickers={pickers} secretsWritable={secretsWritable} />
  )

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <header className="flex items-start gap-3">
        <IntegrationLogo id={id} className="size-12" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <h1 className="text-lg font-medium">{integration.title}</h1>
            <div className="flex items-center gap-3">
              {integration.configured ? <HealthSummary health={integration.health} /> : <StatusBadge integration={integration} />}
              <Button variant="outline" size="sm" onClick={() => test.mutate()} disabled={test.isPending} title="Tests the saved settings">
                {test.isPending ? "Testing..." : "Test connection"}
              </Button>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">{integration.description}</p>
        </div>
      </header>
      {test.error ? <FieldError>{errorText(test.error)}</FieldError> : test.data && <TestResult result={test.data} />}
      {!secretsWritable && (
        <p className="text-xs text-muted-foreground">
          Set SETTINGS_ENCRYPTION_KEY on the server to save tokens and secrets here. Other fields still save.
        </p>
      )}

      {mode.kind === "setup" ? (
        <SetupForm
          sections={sections}
          missing={missingText(integration.missing, fields)}
          webhook={webhook}
          controls={controls}
          extras={extras}
          dirty={isDirtyFor(fields, form)}
          saving={save.isPending}
          error={error}
          onSubmit={() => submit(fields, () => undefined)}
        />
      ) : (
        <Card className="gap-0 divide-y py-0">
          {sections.map((section, index) => {
            const first = index === 0
            const editing = mode.kind === "edit" && mode.section === section.id
            const locked = mode.kind === "edit" && !editing
            if (editing) {
              return (
                <SectionEdit
                  key={section.id}
                  section={section}
                  webhook={first ? webhook : undefined}
                  dirty={isDirtyFor(section.fields, form)}
                  saving={save.isPending}
                  error={error}
                  onSave={() => submit(section.fields, () => close(section))}
                  onCancel={() => close(section)}
                >
                  {controls(section)}
                </SectionEdit>
              )
            }
            const edit = <EditButton disabled={locked} onClick={() => setMode({ kind: "edit", section: section.id })} label={section.title} />
            return (
              <Fragment key={section.id}>
                {section.advanced && extras}
                {section.advanced ? (
                  <section aria-label="Advanced" className="flex items-center gap-3 p-4">
                    <h2 className="text-sm font-medium">Advanced</h2>
                    <span className="mr-auto text-xs text-muted-foreground">{advancedSummary(section)}</span>
                    {edit}
                  </section>
                ) : (
                  <section aria-label={section.title} className="flex flex-col gap-3 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <h2 className="text-sm font-medium">{section.title}</h2>
                      {edit}
                    </div>
                    <dl className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] gap-x-6 gap-y-2.5 text-sm">
                      {first && webhook && (
                        <SummaryRow label="Webhook URL">
                          <WebhookUrlValue url={webhook.url} />
                        </SummaryRow>
                      )}
                      {section.fields.map((field) => (
                        <SummaryRow key={field.key} label={field.label}>
                          <SummaryValue field={field} pickers={pickers} />
                        </SummaryRow>
                      ))}
                    </dl>
                  </section>
                )}
              </Fragment>
            )
          })}
          {!sections.some((s) => s.advanced) && extras}
        </Card>
      )}
    </div>
  )
}

const isDirtyFor = (fields: readonly FieldView[], form: FieldForm) => {
  const built = buildPayload(fields, form.state, form.secretActions)
  return built.ok && isDirty(built.payload)
}

function repoLabelOf(workflow: LinkedTemplate, integrations: readonly IntegrationView[], id: string) {
  const { integration, key } = workflow.integration.repoSetting
  const field = fieldOf(integrations, integration, key)
  if (!field) return "the repository"
  return integration === id ? field.label : `${field.label} on the GitHub integration`
}

function EditButton({ disabled, onClick, label }: { disabled: boolean; onClick: () => void; label: string }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={disabled} aria-label={`Edit ${label}`}>
      Edit
    </Button>
  )
}

function SummaryRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

const DefaultMark = ({ on }: { on: boolean }) => (on ? <span className="ml-1.5 text-xs text-muted-foreground">default</span> : null)

function SummaryValue({ field, pickers }: { field: FieldView; pickers: boolean }) {
  const project = useProjectId()
  const shown = displayValue(field)
  switch (shown.kind) {
    case "secret":
      return shown.set ? (
        <span className="flex flex-wrap items-center gap-x-1.5">
          <StatusDot tone="ok" label="Set" />
          Set
          {shown.fromEnv && <span className="text-xs text-muted-foreground">from the server environment</span>}
        </span>
      ) : (
        <span className="text-muted-foreground">Not set</span>
      )
    case "toggle":
      return (
        <span>
          {shown.on ? "On" : "Off"}
          <DefaultMark on={shown.isDefault} />
        </span>
      )
    case "list": {
      const picker = pickerKindOf(field.kind)
      return (
        <span className="flex flex-wrap items-center gap-1">
          {picker ? (
            <SlackIdBadges kind={picker} ids={shown.items} enabled={pickers} project={project} />
          ) : (
            shown.items.map((item) => (
              <Badge key={item} variant="secondary">
                {item}
              </Badge>
            ))
          )}
          <DefaultMark on={shown.isDefault} />
        </span>
      )
    }
    case "text":
      return (
        <span className="break-words">
          <span className={cn(shown.mono && "font-mono text-xs")}>{shown.text}</span>
          <DefaultMark on={shown.isDefault} />
        </span>
      )
    case "empty":
      return <span className="text-muted-foreground">{shown.text}</span>
  }
}

function SectionHeading({ section }: { section: Section }) {
  return (
    <div className="flex flex-col gap-0.5">
      <h2 className="text-sm font-medium">{section.title}</h2>
      {section.help && <p className="text-xs text-muted-foreground">{section.help}</p>}
    </div>
  )
}

type Webhook = { url: string; title: string }

function SectionEdit({
  section,
  webhook,
  dirty,
  saving,
  error,
  onSave,
  onCancel,
  children,
}: {
  section: Section
  webhook: Webhook | undefined
  dirty: boolean
  saving: boolean
  error: string | undefined
  onSave: () => void
  onCancel: () => void
  children: ReactNode
}) {
  return (
    <form
      aria-label={section.title}
      className="flex flex-col gap-4 bg-muted/30 p-4"
      onSubmit={(event) => {
        event.preventDefault()
        onSave()
      }}
    >
      <SectionHeading section={section} />
      {webhook && <WebhookUrl url={webhook.url} title={webhook.title} />}
      {children}
      <FieldError>{error}</FieldError>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={!dirty || saving}>
          {saving ? "Saving..." : "Save"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function SetupForm({
  sections,
  missing,
  webhook,
  controls,
  extras,
  dirty,
  saving,
  error,
  onSubmit,
}: {
  sections: Section[]
  missing: string | undefined
  webhook: Webhook | undefined
  controls: (section: Section) => ReactNode
  extras: ReactNode
  dirty: boolean
  saving: boolean
  error: string | undefined
  onSubmit: () => void
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const advanced = sections.find((s) => s.advanced)
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <Card className="gap-0 divide-y py-0">
        {missing && <p className="p-4 text-xs text-muted-foreground">{missing}</p>}
        {sections
          .filter((s) => !s.advanced)
          .map((section, index) => (
            <section key={section.id} aria-label={section.title} className="flex flex-col gap-4 p-4">
              <SectionHeading section={section} />
              {index === 0 && webhook && <WebhookUrl url={webhook.url} title={webhook.title} />}
              {controls(section)}
            </section>
          ))}
        {extras}
        {advanced && (
          <section aria-label="Advanced" className="flex flex-col gap-4 p-4">
            <button
              type="button"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((open) => !open)}
              className="flex items-center gap-1.5 self-start text-sm font-medium"
            >
              <CaretRightIcon className={cn("size-3.5 transition-transform", advancedOpen && "rotate-90")} />
              Advanced
              <span className="text-xs font-normal text-muted-foreground">{advancedSummary(advanced)}</span>
            </button>
            {advancedOpen && controls(advanced)}
          </section>
        )}
        <div className="flex flex-col gap-2 p-4">
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={!dirty || saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
            {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
          </div>
          <FieldError>{error}</FieldError>
        </div>
      </Card>
    </form>
  )
}

function TestResult({ result }: { result: ConnectionTestResult }) {
  const Icon = result.ok ? CheckCircleIcon : WarningCircleIcon
  const details = Object.entries(result.details ?? {})
  return (
    <div role="status" className="flex flex-col gap-1 text-xs">
      <p className={cn("flex items-center gap-1.5", !result.ok && "text-destructive")}>
        {result.available && <Icon className="size-3.5 shrink-0" />}
        {result.message}
      </p>
      {details.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted-foreground">
          {details.map(([key, value]) => (
            <div key={key} className="contents">
              <dt>{key}</dt>
              <dd className="font-mono break-all">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

function PosthogActions() {
  const project = useProjectId()
  const preview = useMutation({ mutationFn: () => previewPosthogReport({ data: { project } }) })
  const send = useMutation({ mutationFn: () => runPosthogNow({ data: { project } }) })

  return (
    <section aria-label="Try the report" className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-sm font-medium">Try the report</h2>
        <Button type="button" variant="outline" size="sm" onClick={() => preview.mutate()} disabled={preview.isPending}>
          {preview.isPending ? "Building..." : "Preview report"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            if (window.confirm("Send the PostHog report to Slack now?")) send.mutate()
          }}
          disabled={send.isPending}
        >
          {send.isPending ? "Sending..." : "Send now"}
        </Button>
      </div>
      {preview.error && <FieldError>{errorText(preview.error)}</FieldError>}
      {preview.data &&
        (preview.data.ok ? (
          <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">{preview.data.text}</pre>
        ) : (
          <FieldError>{preview.data.message}</FieldError>
        ))}
      {send.error && <FieldError>{errorText(send.error)}</FieldError>}
      {send.data && (
        <p role="status" className={cn("text-xs", send.data.status !== "succeeded" && "text-destructive")}>
          {send.data.message}
          {"runId" in send.data && send.data.runId && (
            <>
              {" "}
              <Link to="/runs/$id" params={{ id: send.data.runId }} className="underline underline-offset-4">
                View run
              </Link>
            </>
          )}
        </p>
      )}
    </section>
  )
}

import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { CheckCircleIcon, CopyIcon, WarningCircleIcon } from "@phosphor-icons/react"
import type { ConnectionTestResult, FieldView, IntegrationView } from "@automation-server/api/routers/index"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { previewPosthogReport, runPosthogNow, testConnection, updateSettings } from "@/lib/api.functions"
import { errorText } from "@/lib/errors"
import { settingsQuery, systemQuery } from "@/lib/queries"
import { buildPayload, initialState, isDirty, type FormState, type SecretAction } from "@/lib/settings-form"

const SOURCE_NOTE: Partial<Record<FieldView["source"], string>> = {
  env: "From the server environment.",
  default: "Default value.",
}

export function IntegrationCard({
  integration,
  secretsWritable,
  webhookUrl,
}: {
  integration: IntegrationView
  secretsWritable: boolean
  webhookUrl: string | undefined
}) {
  const queryClient = useQueryClient()
  const { id, fields } = integration
  const [state, setState] = useState<FormState>(() => initialState(fields))
  const [secretActions, setSecretActions] = useState<Record<string, SecretAction>>({})
  const [replacing, setReplacing] = useState<ReadonlySet<string>>(new Set())
  const [formError, setFormError] = useState<string>()

  const built = buildPayload(fields, state, secretActions)
  const dirty = built.ok && isDirty(built.payload)

  const save = useMutation({
    mutationFn: (payload: { values: Record<string, unknown>; clear: string[] }) =>
      updateSettings({ data: { integrationId: id, ...payload } }),
    onSuccess: (view) => {
      queryClient.setQueryData(settingsQuery().queryKey, view)
      void queryClient.invalidateQueries({ queryKey: systemQuery().queryKey })
    },
  })
  const test = useMutation({ mutationFn: () => testConnection({ data: { integrationId: id } }) })

  const set = (key: string, value: string | boolean) => setState((prev) => ({ ...prev, [key]: value }))
  const setReplace = (key: string, on: boolean) => {
    setReplacing((prev) => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
    if (!on) set(key, "")
  }
  const setSecretAction = (key: string, action: SecretAction) =>
    setSecretActions((prev) => ({ ...prev, [key]: action }))

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!built.ok) {
      setFormError(built.error)
      return
    }
    setFormError(undefined)
    save.mutate(built.payload)
  }

  const missing = integration.missing.map((key) => fields.find((f) => f.key === key)?.label ?? key)

  return (
    <Card>
      <CardHeader>
        <CardTitle>{integration.title}</CardTitle>
        <CardDescription>{integration.description}</CardDescription>
        <CardAction>
          {integration.configured ? (
            <Badge variant="secondary">Configured</Badge>
          ) : (
            <Badge variant="outline">Not configured</Badge>
          )}
        </CardAction>
      </CardHeader>
      <form onSubmit={onSubmit} className="contents">
        <CardContent className="flex flex-col gap-4">
          {!integration.configured && missing.length > 0 && (
            <p className="text-xs text-muted-foreground">Missing: {missing.join(", ")}.</p>
          )}
          {integration.webhookSource && <WebhookUrl url={webhookUrl} title={integration.title} />}
          <FieldGroup className="gap-4">
            {fields.map((field) => (
              <Field key={field.key}>
                <FieldLabel htmlFor={`${id}-${field.key}`}>
                  {field.label}
                  {field.required && <span className="text-muted-foreground">(required)</span>}
                </FieldLabel>
                {field.kind === "secret" ? (
                  <SecretInput
                    id={`${id}-${field.key}`}
                    field={field}
                    value={String(state[field.key] ?? "")}
                    onChange={(value) => set(field.key, value)}
                    action={secretActions[field.key] ?? "keep"}
                    onAction={(action) => setSecretAction(field.key, action)}
                    replacing={replacing.has(field.key)}
                    onReplace={(on) => setReplace(field.key, on)}
                    writable={secretsWritable}
                  />
                ) : (
                  <PlainInput
                    id={`${id}-${field.key}`}
                    field={field}
                    value={state[field.key] ?? ""}
                    onChange={(value) => set(field.key, value)}
                  />
                )}
                <FieldNote field={field} />
              </Field>
            ))}
          </FieldGroup>
          {id === "posthog" && <PosthogActions configured={integration.configured} />}
        </CardContent>
        <CardFooter className="flex flex-col items-stretch gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={!dirty || save.isPending}>
              {save.isPending ? "Saving..." : "Save"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => test.mutate()}
              disabled={test.isPending}
              title="Tests the saved settings"
            >
              {test.isPending ? "Testing..." : "Test connection"}
            </Button>
            {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
          </div>
          <FieldError>{formError ?? (save.error ? errorText(save.error) : undefined)}</FieldError>
          {test.error ? (
            <FieldError>{errorText(test.error)}</FieldError>
          ) : (
            test.data && <TestResult result={test.data} />
          )}
        </CardFooter>
      </form>
    </Card>
  )
}

function FieldNote({ field }: { field: FieldView }) {
  const note = [field.help, field.kind === "secret" ? undefined : SOURCE_NOTE[field.source]].filter(Boolean).join(" ")
  return note ? <FieldDescription>{note}</FieldDescription> : null
}

function PlainInput({
  id,
  field,
  value,
  onChange,
}: {
  id: string
  field: FieldView
  value: string | boolean
  onChange: (value: string | boolean) => void
}) {
  if (field.kind === "boolean") {
    return <Switch id={id} checked={value === true} onCheckedChange={onChange} />
  }
  const text = typeof value === "string" ? value : ""
  const placeholder = field.default === undefined ? undefined : String(field.default)
  if (field.kind === "list") {
    return (
      <Textarea
        id={id}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        placeholder="One per line"
        rows={2}
      />
    )
  }
  if (field.kind === "select" && field.options) {
    return (
      <Select value={text} onValueChange={(next) => onChange(String(next ?? ""))}>
        <SelectTrigger id={id} className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {field.options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }
  return (
    <Input
      id={id}
      type={field.kind === "number" ? "number" : "text"}
      min={field.min}
      max={field.max}
      value={text}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={false}
    />
  )
}

function SecretInput({
  id,
  field,
  value,
  onChange,
  action,
  onAction,
  replacing,
  onReplace,
  writable,
}: {
  id: string
  field: FieldView
  value: string
  onChange: (value: string) => void
  action: SecretAction
  onAction: (action: SecretAction) => void
  replacing: boolean
  onReplace: (on: boolean) => void
  writable: boolean
}) {
  if (action === "clear") {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Cleared on save.</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => onAction("keep")}>
          Undo
        </Button>
      </div>
    )
  }
  if (field.set && !replacing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">Set</Badge>
        {field.source === "env" && <span className="text-xs text-muted-foreground">from the server environment</span>}
        <Button type="button" variant="outline" size="sm" onClick={() => onReplace(true)} disabled={!writable}>
          Replace
        </Button>
        {field.source === "db" && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onAction("clear")}>
            Clear
          </Button>
        )}
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2">
      <Input
        id={id}
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={writable ? (field.set ? "New value" : "Not set") : "Needs SETTINGS_ENCRYPTION_KEY on the server"}
        disabled={!writable}
        autoComplete="new-password"
        spellCheck={false}
      />
      {replacing && (
        <Button type="button" variant="ghost" size="sm" onClick={() => onReplace(false)}>
          Cancel
        </Button>
      )}
    </div>
  )
}

function WebhookUrl({ url, title }: { url: string | undefined; title: string }) {
  const [copied, setCopied] = useState(false)
  if (!url) return null
  const relative = url.startsWith("/")

  return (
    <Field>
      <FieldLabel htmlFor={`${title}-webhook`}>Webhook URL</FieldLabel>
      <div className="flex items-center gap-2">
        <Input id={`${title}-webhook`} value={url} readOnly className="font-mono" onFocus={(e) => e.target.select()} />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Copy webhook URL"
          onClick={() =>
            void navigator.clipboard.writeText(url).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }
        >
          {copied ? <CheckCircleIcon /> : <CopyIcon />}
        </Button>
      </div>
      <FieldDescription>
        Paste this into the {title} webhook settings.
        {relative && " Set PUBLIC_URL on the server to show the full URL."}
      </FieldDescription>
    </Field>
  )
}

function TestResult({ result }: { result: ConnectionTestResult }) {
  const Icon = result.ok ? CheckCircleIcon : WarningCircleIcon
  const details = Object.entries(result.details ?? {})
  return (
    <div role="status" className="flex flex-col gap-1 text-xs">
      <p className={`flex items-center gap-1.5 ${result.ok ? "" : "text-destructive"}`}>
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

function PosthogActions({ configured }: { configured: boolean }) {
  const preview = useMutation({ mutationFn: () => previewPosthogReport() })
  const send = useMutation({ mutationFn: () => runPosthogNow() })

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto text-xs font-medium">Weekly report</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => preview.mutate()}
          disabled={!configured || preview.isPending}
        >
          {preview.isPending ? "Building..." : "Preview report"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            if (window.confirm("Send the PostHog report to Slack now?")) send.mutate()
          }}
          disabled={!configured || send.isPending}
        >
          {send.isPending ? "Sending..." : "Send now"}
        </Button>
      </div>
      {!configured && <p className="text-xs text-muted-foreground">Save the required fields to preview or send.</p>}
      {preview.error && <FieldError>{errorText(preview.error)}</FieldError>}
      {preview.data !== undefined && (
        <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">{preview.data}</pre>
      )}
      {send.error && <FieldError>{errorText(send.error)}</FieldError>}
      {send.data && (
        <p role="status" className={`text-xs ${send.data.ok ? "" : "text-destructive"}`}>
          {send.data.message}
          {send.data.runId && (
            <>
              {" "}
              <Link to="/runs/$id" params={{ id: send.data.runId }} className="underline underline-offset-4">
                View run
              </Link>
            </>
          )}
        </p>
      )}
    </div>
  )
}

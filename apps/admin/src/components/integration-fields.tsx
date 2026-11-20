import { useState } from "react"
import { CheckCircleIcon, CopyIcon } from "@phosphor-icons/react"
import type { FieldView } from "@automation-server/api/routers/index"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { SlackPicker } from "@/components/slack-picker"
import { useProjectId } from "@/lib/project"
import { initialState, type FormState, type FormValue, type SecretAction } from "@/lib/settings-form"
import { isListKind, pickerKindOf, PICKERS_DISABLED_NOTICE } from "@/lib/slack-picker"

export type FieldForm = {
  state: FormState
  secretActions: Readonly<Record<string, SecretAction>>
  replacing: ReadonlySet<string>
  set: (key: string, value: FormValue) => void
  setReplace: (key: string, on: boolean) => void
  setSecretAction: (key: string, action: SecretAction) => void
  reset: (keys: readonly string[]) => void
}

const without = <T,>(record: Readonly<Record<string, T>>, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)))

export function useFieldForm(fields: readonly FieldView[]): FieldForm {
  const [state, setState] = useState<FormState>(() => initialState(fields))
  const [secretActions, setSecretActions] = useState<Record<string, SecretAction>>({})
  const [replacing, setReplacing] = useState<ReadonlySet<string>>(new Set())

  const set = (key: string, value: FormValue) => setState((prev) => ({ ...prev, [key]: value }))
  return {
    state,
    secretActions,
    replacing,
    set,
    setReplace: (key, on) => {
      setReplacing((prev) => {
        const next = new Set(prev)
        if (on) next.add(key)
        else next.delete(key)
        return next
      })
      if (!on) set(key, "")
    },
    setSecretAction: (key, action) => setSecretActions((prev) => ({ ...prev, [key]: action })),
    reset: (keys) => {
      const initial = initialState(fields)
      setState((prev) => ({ ...prev, ...Object.fromEntries(keys.map((key) => [key, initial[key]!])) }))
      setSecretActions((prev) => without(prev, keys))
      setReplacing((prev) => new Set([...prev].filter((key) => !keys.includes(key))))
    },
  }
}

export function FieldControls({
  integrationId,
  fields,
  form,
  pickers,
  secretsWritable,
}: {
  integrationId: string
  fields: readonly FieldView[]
  form: FieldForm
  pickers: boolean
  secretsWritable: boolean
}) {
  const project = useProjectId()
  return (
    <>
      {!pickers && fields.some((f) => pickerKindOf(f.kind)) && (
        <p role="note" className="rounded-md border border-dashed p-2.5 text-xs text-muted-foreground">
          {PICKERS_DISABLED_NOTICE}
        </p>
      )}
      <FieldGroup className="gap-4">
        {fields.map((field) => {
          const id = `${integrationId}-${field.key}`
          const picker = pickerKindOf(field.kind)
          return (
            <Field key={field.key}>
              <FieldLabel htmlFor={id}>
                {field.label}
                {field.required && <span className="text-muted-foreground">(required)</span>}
              </FieldLabel>
              {field.kind === "secret" ? (
                <SecretInput
                  id={id}
                  field={field}
                  value={String(form.state[field.key] ?? "")}
                  onChange={(value) => form.set(field.key, value)}
                  action={form.secretActions[field.key] ?? "keep"}
                  onAction={(action) => form.setSecretAction(field.key, action)}
                  replacing={form.replacing.has(field.key)}
                  onReplace={(on) => form.setReplace(field.key, on)}
                  writable={secretsWritable}
                />
              ) : picker ? (
                <SlackPicker
                  id={id}
                  kind={picker}
                  value={String(form.state[field.key] ?? "")}
                  onChange={(value) => form.set(field.key, value)}
                  enabled={pickers}
                  project={project}
                />
              ) : (
                <PlainInput id={id} field={field} value={form.state[field.key] ?? ""} onChange={(value) => form.set(field.key, value)} />
              )}
              <FieldNote field={field} />
            </Field>
          )
        })}
      </FieldGroup>
    </>
  )
}

// A secret already says where it comes from next to its Set badge.
function FieldNote({ field }: { field: FieldView }) {
  const fromEnv = field.source === "env" && field.kind !== "secret"
  const note = [field.help, fromEnv ? "From the server environment." : undefined].filter(Boolean).join(" ")
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
  value: FormValue
  onChange: (value: FormValue) => void
}) {
  if (field.kind === "boolean") {
    return <Switch id={id} checked={value === true} onCheckedChange={onChange} />
  }
  const text = typeof value === "string" ? value : ""
  const placeholder = field.default === undefined ? undefined : String(field.default)
  if (isListKind(field.kind)) {
    return <Textarea id={id} value={text} onChange={(e) => onChange(e.target.value)} placeholder="One per line" rows={2} />
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
      step={field.kind === "number" ? "any" : undefined}
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

function CopyButton({ text, label, size = "icon" }: { text: string; label: string; size?: "icon" | "icon-sm" }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      aria-label={label}
      title={label}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }
    >
      {copied ? <CheckCircleIcon /> : <CopyIcon />}
    </Button>
  )
}

export function WebhookUrl({ url, title }: { url: string; title: string }) {
  const relative = url.startsWith("/")
  return (
    <Field>
      <FieldLabel htmlFor={`${title}-webhook`}>Webhook URL</FieldLabel>
      <div className="flex items-center gap-2">
        <Input id={`${title}-webhook`} value={url} readOnly className="font-mono" onFocus={(e) => e.target.select()} />
        <CopyButton text={url} label="Copy webhook URL" />
      </div>
      <FieldDescription>
        Paste this into the {title} webhook settings.
        {relative && " Set PUBLIC_URL on the server to show the full URL."}
      </FieldDescription>
    </Field>
  )
}

export function WebhookUrlValue({ url }: { url: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate font-mono text-xs" title={url}>
        {url}
      </span>
      <CopyButton text={url} label="Copy webhook URL" size="icon-sm" />
    </span>
  )
}

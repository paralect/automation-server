import { useState } from "react"

import { ProjectIcon } from "@/components/project-icon"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"

export type ProjectFormValues = { name: string; domain: string }

/** Name and domain fields with a live icon preview. The parent owns submit, so it can sit in a dialog or a card. */
export function ProjectFields({
  id,
  values,
  onChange,
  error,
  autoFocus = false,
}: {
  id: string
  autoFocus?: boolean
  values: ProjectFormValues
  onChange: (values: ProjectFormValues) => void
  error?: string
}) {
  const [previewDomain, setPreviewDomain] = useState(values.domain)
  const domain = hostnameOf(previewDomain)

  return (
    <FieldGroup className="gap-4">
      <Field>
        <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
        <div className="flex items-center gap-2">
          <ProjectIcon project={{ id: values.name || "new", name: values.name || "?", domain }} className="size-8 text-base" />
          <Input
            id={`${id}-name`}
            value={values.name}
            maxLength={60}
            required
            autoFocus={autoFocus}
            placeholder="Fireprompts"
            onChange={(e) => onChange({ ...values, name: e.target.value })}
          />
        </div>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-domain`}>Domain</FieldLabel>
        <Input
          id={`${id}-domain`}
          value={values.domain}
          placeholder="fireprompts.com"
          onChange={(e) => onChange({ ...values, domain: e.target.value })}
          onBlur={() => setPreviewDomain(values.domain)}
        />
        <FieldDescription>Optional. The site's favicon becomes the project icon.</FieldDescription>
      </Field>
      {error && <FieldError>{error}</FieldError>}
    </FieldGroup>
  )
}

// Mirrors the server's normalization closely enough for the preview. The server has the final say.
function hostnameOf(input: string): string | null {
  const raw = input.trim().toLowerCase()
  if (!raw) return null
  try {
    const host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.replace(/^www\./, "")
    return host.includes(".") ? host : null
  } catch {
    return null
  }
}

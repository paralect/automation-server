import type { FieldView } from "@automation-server/api/routers/index"

import { isListKind } from "./slack-picker"

export type Section = { id: string; title: string; help?: string; fields: FieldView[]; advanced: boolean }

export const ADVANCED_SECTION_ID = "advanced"

const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-")

// Groups appear in the order their first field does, so the spec decides the page layout. Advanced fields always come last, whatever their place in the spec.
export function sectionsOf(fields: readonly FieldView[]): Section[] {
  const sections: Section[] = []
  for (const field of fields) {
    if (field.advanced) continue
    const title = field.group ?? "Settings"
    const found = sections.find((s) => s.title === title)
    if (found) {
      found.fields.push(field)
      found.help ??= field.groupHelp
    } else {
      sections.push({ id: slug(title), title, ...(field.groupHelp ? { help: field.groupHelp } : {}), fields: [field], advanced: false })
    }
  }
  const advanced = fields.filter((f) => f.advanced)
  if (advanced.length > 0) sections.push({ id: ADVANCED_SECTION_ID, title: "Advanced", fields: advanced, advanced: true })
  return sections
}

export type DisplayValue =
  | { kind: "secret"; set: boolean; fromEnv: boolean }
  | { kind: "toggle"; on: boolean; isDefault: boolean }
  | { kind: "list"; items: string[]; isDefault: boolean }
  | { kind: "text"; text: string; mono: boolean; isDefault: boolean }
  | { kind: "empty"; text: string }

const isDefaultValue = (field: FieldView) =>
  field.default !== undefined && JSON.stringify(field.value) === JSON.stringify(field.default)

const hasValue = (field: FieldView) =>
  field.kind === "secret" ? field.set : Array.isArray(field.value) ? field.value.length > 0 : field.set

export function displayValue(field: FieldView): DisplayValue {
  if (field.kind === "secret") return { kind: "secret", set: field.set, fromEnv: field.source === "env" }
  const isDefault = isDefaultValue(field)
  if (field.kind === "boolean") return { kind: "toggle", on: field.value === true, isDefault }
  if (!hasValue(field)) return { kind: "empty", text: "Not set" }
  if (isListKind(field.kind)) return { kind: "list", items: Array.isArray(field.value) ? field.value : [], isDefault }
  const text = String(field.value)
  // Repositories, URLs, model ids and file names have no spaces. Prose like a report title reads better in the body font.
  return { kind: "text", text, mono: field.kind === "text" && !/\s/.test(text), isDefault }
}

const customizedAdvanced = (section: Section): FieldView[] =>
  section.fields.filter((f) => hasValue(f) && !isDefaultValue(f))

export function advancedSummary(section: Section): string {
  const changed = customizedAdvanced(section)
  return changed.length === 0 ? "All defaults" : `${changed.map((f) => f.label).join(", ")} changed`
}

import type { FieldView } from "@automation-server/api/routers/index"

import { idsOf, isListKind } from "./slack-picker"

export type FormValue = string | boolean
export type FormState = Record<string, FormValue>
export type SecretAction = "keep" | "clear"
export type UpdatePayload = { values: Record<string, unknown>; clear: string[] }
export type PayloadResult = { ok: true; payload: UpdatePayload } | { ok: false; error: string }

export function initialState(fields: readonly FieldView[]): FormState {
  const state: FormState = {}
  for (const f of fields) {
    if (f.kind === "secret") state[f.key] = ""
    else if (f.kind === "boolean") state[f.key] = f.value === true
    else if (isListKind(f.kind)) state[f.key] = Array.isArray(f.value) ? f.value.join("\n") : ""
    else state[f.key] = f.value === undefined ? "" : String(f.value)
  }
  return state
}

export const parseList = idsOf

export function buildPayload(
  fields: readonly FieldView[],
  state: FormState,
  secretActions: Readonly<Record<string, SecretAction>>,
): PayloadResult {
  const initial = initialState(fields)
  const values: Record<string, unknown> = {}
  const clear: string[] = []

  for (const f of fields) {
    const next = state[f.key]
    if (f.kind === "secret") {
      if (secretActions[f.key] === "clear") clear.push(f.key)
      else if (typeof next === "string" && next.length > 0) values[f.key] = next
      continue
    }
    if (next === initial[f.key]) continue

    if (f.kind === "boolean") {
      values[f.key] = next === true
      continue
    }
    const text = typeof next === "string" ? next : ""
    if (isListKind(f.kind)) {
      const list = parseList(text)
      if (list.length === 0) clear.push(f.key)
      else values[f.key] = list
    } else if (text.trim() === "") {
      clear.push(f.key)
    } else if (f.kind === "number") {
      const n = Number(text)
      if (!Number.isFinite(n)) return { ok: false, error: `${f.label} must be a number` }
      values[f.key] = n
    } else {
      values[f.key] = text.trim()
    }
  }
  return { ok: true, payload: { values, clear } }
}

export const isDirty = (payload: UpdatePayload) => Object.keys(payload.values).length > 0 || payload.clear.length > 0

// Entries of `missing` that name a field become its label. Anything else is a sentence from the server, such as the one for "set up one of these", and is shown as is.
export function missingText(missing: readonly string[], fields: readonly FieldView[]): string | undefined {
  if (missing.length === 0) return undefined
  const labels = new Map(fields.map((f) => [f.key, f.label]))
  const named = missing.filter((m) => labels.has(m)).map((m) => labels.get(m)!)
  const sentences = missing.filter((m) => !labels.has(m))
  return [...(named.length > 0 ? [`Missing: ${named.join(", ")}.`] : []), ...sentences].join(" ")
}

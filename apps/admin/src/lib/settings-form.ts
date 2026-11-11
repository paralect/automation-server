import type { FieldView } from "@automation-server/api/routers/index"

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
    else if (f.kind === "list") state[f.key] = Array.isArray(f.value) ? f.value.join("\n") : ""
    else state[f.key] = f.value === undefined ? "" : String(f.value)
  }
  return state
}

export const parseList = (text: string) =>
  text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)

/**
 * Maps edited form state to a `settings.update` payload. Only fields that differ from the loaded state are sent,
 * so untouched env-sourced values are not copied into the database. An emptied optional field is cleared so it
 * falls back to env or default. A secret is sent only when something was typed, and `clear` marks it for removal.
 */
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
    if (f.kind === "list") {
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

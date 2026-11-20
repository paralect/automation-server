import type { DirectoryItem, FieldView } from "@automation-server/api/routers/index"

export type PickerKind = "users" | "channels"

export const pickerKindOf = (kind: FieldView["kind"]): PickerKind | undefined =>
  kind === "slackUsers" ? "users" : kind === "slackChannels" ? "channels" : undefined

export const isListKind = (kind: FieldView["kind"]) => kind === "list" || pickerKindOf(kind) !== undefined

export const PICKERS_DISABLED_NOTICE = "Save the bot token and signing secret first, then choose who can use the bot."
export const NO_USERS_NOTICE = "Nobody can use the bot yet. Choose at least one user."

// The pickers need the saved token, so a value typed but not saved does not count.
export const pickersEnabled = (fields: readonly FieldView[]): boolean => fields.find((f) => f.key === "botToken")?.set === true

export const idsOf = (text: string): string[] =>
  text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)

export const textOf = (ids: readonly string[]): string => ids.join("\n")

export const removeId = (ids: readonly string[], id: string): string[] => ids.filter((x) => x !== id)

// Keeps the order of what was already chosen, then appends the newly chosen ones. IDs the directory does not know stay when still selected.
export function mergeSelection(current: readonly string[], chosen: readonly string[]): string[] {
  const keep = new Set(chosen)
  const kept = current.filter((id) => keep.has(id))
  const known = new Set(kept)
  return [...kept, ...chosen.filter((id) => !known.has(id) && known.add(id))]
}

export const toggleId = (ids: readonly string[], id: string): string[] => (ids.includes(id) ? removeId(ids, id) : [...ids, id])

export type Chip = {
  id: string
  label: string
  // False only once the directory was read and does not list the ID.
  found: boolean
}

// A stored ID the directory does not return is kept and shown raw, never dropped. While the directory is not loaded, every ID is shown raw without a hint.
export function resolveChips(ids: readonly string[], items: readonly DirectoryItem[] | undefined): Chip[] {
  const byId = new Map((items ?? []).map((i) => [i.id, i]))
  return ids.map((id) => {
    const item = byId.get(id)
    return { id, label: item?.label ?? id, found: items === undefined || item !== undefined }
  })
}

const ID_PATTERN: Record<PickerKind, RegExp> = {
  users: /^[UW][A-Z0-9]+$/,
  channels: /^[CG][A-Z0-9]+$/,
}

const ID_HINT: Record<PickerKind, string> = {
  users: "A member ID starts with U or W, for example U01ABC23DEF.",
  channels: "A channel ID starts with C or G, for example C01ABC23DEF.",
}

export type ManualId = { ok: true; id: string } | { ok: false; error: string }

export function parseManualId(kind: PickerKind, text: string): ManualId {
  const id = text.trim().toUpperCase()
  if (!ID_PATTERN[kind].test(id)) return { ok: false, error: ID_HINT[kind] }
  return { ok: true, id }
}

export const MISSING_SCOPE_HINT = "Until then the list cannot load. You can still add IDs by hand."

export const isMissingScope = (message: string) => /scope/i.test(message)

export type WouldDo = { readonly kind: "issue" | "dispatch" | "note"; readonly text: string; readonly detail?: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

// Reads the dry-run part of a crisp-triage outcome. Anything that is not a dry-run outcome yields no actions.
export function wouldDo(outcome: unknown): readonly WouldDo[] {
  if (!isRecord(outcome) || outcome.dryRun !== true || !isRecord(outcome.wouldDo)) return []
  const { issue, dispatch } = outcome.wouldDo
  const actions: WouldDo[] = []
  if (isRecord(issue) && typeof issue.title === "string") {
    const labels = Array.isArray(issue.labels) ? issue.labels.filter((l): l is string => typeof l === "string") : []
    actions.push({ kind: "issue", text: `Would create issue "${issue.title}"`, ...(labels.length ? { detail: `Labels: ${labels.join(", ")}` } : {}) })
  }
  if (dispatch === true) actions.push({ kind: "dispatch", text: "Would dispatch the Codex fix workflow for that issue" })
  if (typeof outcome.note === "string") actions.push({ kind: "note", text: "Would post this private note to the Crisp conversation", detail: outcome.note })
  return actions
}

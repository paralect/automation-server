import { describe, expect, test } from "bun:test"

import { wouldDo } from "./would-do"

describe("wouldDo", () => {
  test("lists the issue, the dispatch and the note of a dry-run outcome", () => {
    const actions = wouldDo({
      dryRun: true,
      note: "Decision: fix.",
      wouldDo: { issue: { title: "[Crisp] Export is broken", labels: ["crisp", "bug"] }, dispatch: true },
    })
    expect(actions).toEqual([
      { kind: "issue", text: 'Would create issue "[Crisp] Export is broken"', detail: "Labels: crisp, bug" },
      { kind: "dispatch", text: "Would dispatch the Codex fix workflow for that issue" },
      { kind: "note", text: "Would post this private note to the Crisp conversation", detail: "Decision: fix." },
    ])
  })

  test("a decision with no issue only lists the note", () => {
    expect(wouldDo({ dryRun: true, note: "n", wouldDo: { issue: null, dispatch: false } }).map((a) => a.kind)).toEqual(["note"])
  })

  test("a live outcome, a missing outcome and junk yield nothing", () => {
    expect(wouldDo({ note: "n" })).toEqual([])
    expect(wouldDo(null)).toEqual([])
    expect(wouldDo({ dryRun: true, wouldDo: "x" })).toEqual([])
  })
})

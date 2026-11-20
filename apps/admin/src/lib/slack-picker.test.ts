import { describe, expect, test } from "bun:test"
import type { FieldView } from "@automation-server/api/routers/index"

import { groupFields, idsOf, isMissingScope, mergeSelection, parseManualId, pickersEnabled, removeId, resolveChips, textOf, toggleId } from "./slack-picker"

const field = (over: Partial<FieldView> & Pick<FieldView, "key" | "kind">): FieldView => ({
  label: over.key,
  required: false,
  advanced: false,
  source: "default",
  set: false,
  ...over,
})

describe("groupFields", () => {
  test("keeps spec order, with each group where its first field is", () => {
    const groups = groupFields([
      field({ key: "token", kind: "secret", group: "Connection", groupHelp: "Save first." }),
      field({ key: "on", kind: "boolean", group: "Access" }),
      field({ key: "secret", kind: "secret", group: "Connection" }),
      field({ key: "model", kind: "text", group: "Advanced" }),
      field({ key: "users", kind: "slackUsers", group: "Access" }),
    ])
    expect(groups.map((g) => [g.name, g.fields.map((f) => f.key)])).toEqual([
      ["Connection", ["token", "secret"]],
      ["Access", ["on", "users"]],
      ["Advanced", ["model"]],
    ])
    expect(groups[0]!.help).toBe("Save first.")
  })

  test("an integration without groups is one section with no heading", () => {
    const groups = groupFields([field({ key: "a", kind: "text" }), field({ key: "b", kind: "text" })])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.name).toBeUndefined()
    expect(groups[0]!.fields.map((f) => f.key)).toEqual(["a", "b"])
  })
})

describe("pickersEnabled", () => {
  test("follows the saved flag of the bot token, not what is typed", () => {
    expect(pickersEnabled([field({ key: "botToken", kind: "secret", set: false }), field({ key: "signingSecret", kind: "secret", set: true })])).toBe(false)
    expect(pickersEnabled([field({ key: "botToken", kind: "secret", set: true, source: "db" })])).toBe(true)
    expect(pickersEnabled([field({ key: "other", kind: "text", set: true })])).toBe(false)
  })
})

describe("selection", () => {
  test("text round trips through ids", () => {
    expect(idsOf("U1\n U2, U3\n\n")).toEqual(["U1", "U2", "U3"])
    expect(textOf(["U1", "U2"])).toBe("U1\nU2")
    expect(idsOf("")).toEqual([])
  })

  test("removal and toggling touch only the one id", () => {
    expect(removeId(["U1", "U2"], "U1")).toEqual(["U2"])
    expect(toggleId(["U1"], "U2")).toEqual(["U1", "U2"])
    expect(toggleId(["U1", "U2"], "U1")).toEqual(["U2"])
  })

  test("merging keeps the existing order, appends new ids once and drops what was unchecked", () => {
    expect(mergeSelection(["U3", "U1"], ["U1", "U2", "U3", "U2"])).toEqual(["U3", "U1", "U2"])
    expect(mergeSelection(["U1", "U2"], ["U2"])).toEqual(["U2"])
    expect(mergeSelection(["U1"], [])).toEqual([])
  })

  test("an id the directory cannot return survives a merge while still chosen", () => {
    expect(mergeSelection(["UEXT"], ["UEXT", "U1"])).toEqual(["UEXT", "U1"])
  })
})

describe("resolveChips", () => {
  const items = [{ id: "U1", label: "Alice", detail: "@alice" }]

  test("shows the label, and an id the directory lacks as the raw id marked not found", () => {
    expect(resolveChips(["U1", "UGONE"], items)).toEqual([
      { id: "U1", label: "Alice", found: true },
      { id: "UGONE", label: "UGONE", found: false },
    ])
  })

  test("before the directory loads nothing is marked not found", () => {
    expect(resolveChips(["U1", "UGONE"], undefined)).toEqual([
      { id: "U1", label: "U1", found: true },
      { id: "UGONE", label: "UGONE", found: true },
    ])
  })

  test("an empty directory marks every stored id not found", () => {
    expect(resolveChips(["U1"], [])).toEqual([{ id: "U1", label: "U1", found: false }])
  })
})

describe("parseManualId", () => {
  test("normalizes case and checks the prefix for the kind", () => {
    expect(parseManualId("users", " u01abc ")).toEqual({ ok: true, id: "U01ABC" })
    expect(parseManualId("users", "W02DEF")).toEqual({ ok: true, id: "W02DEF" })
    expect(parseManualId("channels", "g03xyz")).toEqual({ ok: true, id: "G03XYZ" })
    expect(parseManualId("users", "C01ABC").ok).toBe(false)
    expect(parseManualId("channels", "U01ABC").ok).toBe(false)
    expect(parseManualId("channels", "#general").ok).toBe(false)
    expect(parseManualId("users", "").ok).toBe(false)
  })
})

describe("isMissingScope", () => {
  test("recognizes the server's scope message", () => {
    expect(isMissingScope("Slack says the app is missing a scope. Add the users:read scope to the Slack app and reinstall it.")).toBe(true)
    expect(isMissingScope("Slack rejected the bot token.")).toBe(false)
  })
})

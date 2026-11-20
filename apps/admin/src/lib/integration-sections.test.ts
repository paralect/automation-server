import { describe, expect, test } from "bun:test"
import type { FieldView } from "@automation-server/api/routers/index"

import { advancedSummary, displayValue, sectionsOf } from "./integration-sections"

const field = (over: Partial<FieldView> & Pick<FieldView, "key" | "kind">): FieldView => ({
  label: over.key,
  required: false,
  advanced: false,
  source: "unset",
  set: false,
  ...over,
})

describe("sectionsOf", () => {
  test("keeps spec order, with each group where its first field is and advanced fields last", () => {
    const sections = sectionsOf([
      field({ key: "token", kind: "secret", group: "Connection", groupHelp: "Save first." }),
      field({ key: "model", kind: "text", advanced: true }),
      field({ key: "on", kind: "boolean", group: "Bot access" }),
      field({ key: "secret", kind: "secret", group: "Connection" }),
      field({ key: "users", kind: "slackUsers", group: "Bot access" }),
    ])
    expect(sections.map((s) => [s.id, s.title, s.advanced, s.fields.map((f) => f.key)])).toEqual([
      ["connection", "Connection", false, ["token", "secret"]],
      ["bot-access", "Bot access", false, ["on", "users"]],
      ["advanced", "Advanced", true, ["model"]],
    ])
    expect(sections[0]!.help).toBe("Save first.")
    expect(sections[1]!.help).toBeUndefined()
  })

  test("fields without a group share one Settings section, and no advanced fields means no Advanced section", () => {
    const sections = sectionsOf([field({ key: "a", kind: "text" }), field({ key: "b", kind: "text" })])
    expect(sections.map((s) => [s.title, s.fields.map((f) => f.key)])).toEqual([["Settings", ["a", "b"]]])
  })
})

describe("displayValue", () => {
  test("a secret says only whether it is set and whether the server environment set it", () => {
    expect(displayValue(field({ key: "t", kind: "secret", set: true, source: "env" }))).toEqual({ kind: "secret", set: true, fromEnv: true })
    expect(displayValue(field({ key: "t", kind: "secret" }))).toEqual({ kind: "secret", set: false, fromEnv: false })
  })

  test("a boolean is a toggle, marked default when it matches the default", () => {
    expect(displayValue(field({ key: "b", kind: "boolean", value: true, set: true, default: true, source: "default" }))).toEqual({ kind: "toggle", on: true, isDefault: true })
    expect(displayValue(field({ key: "b", kind: "boolean", value: false, set: true, default: true, source: "db" }))).toEqual({ kind: "toggle", on: false, isDefault: false })
  })

  test("lists show their items, and an empty list is not set", () => {
    expect(displayValue(field({ key: "l", kind: "list", value: ["error", "fatal"], set: true, default: ["error", "fatal"], source: "default" }))).toEqual({ kind: "list", items: ["error", "fatal"], isDefault: true })
    expect(displayValue(field({ key: "l", kind: "slackChannels", value: [], set: true, source: "db" }))).toEqual({ kind: "empty", text: "Not set" })
  })

  test("text is mono only when it reads as an identifier", () => {
    expect(displayValue(field({ key: "r", kind: "text", value: "acme/web", set: true, source: "db" }))).toEqual({ kind: "text", text: "acme/web", mono: true, isDefault: false })
    expect(displayValue(field({ key: "t", kind: "text", value: "Weekly report", set: true, default: "Weekly report", source: "default" }))).toEqual({ kind: "text", text: "Weekly report", mono: false, isDefault: true })
    expect(displayValue(field({ key: "n", kind: "number", value: 3, set: true, default: 3, source: "default" }))).toEqual({ kind: "text", text: "3", mono: false, isDefault: true })
  })

  test("an unset field, or one whose default is empty, is not set", () => {
    expect(displayValue(field({ key: "x", kind: "text" }))).toEqual({ kind: "empty", text: "Not set" })
    expect(displayValue(field({ key: "ref", kind: "text", value: "", default: "", source: "default" }))).toEqual({ kind: "empty", text: "Not set" })
  })
})

describe("advancedSummary", () => {
  const advanced = (fields: FieldView[]) => sectionsOf(fields.map((f) => ({ ...f, advanced: true })))[0]!

  test("says all defaults when nothing was changed or set", () => {
    expect(advancedSummary(advanced([
      field({ key: "url", kind: "text", value: "https://slack.com/api", set: true, default: "https://slack.com/api", source: "default" }),
      field({ key: "model", kind: "text" }),
    ]))).toBe("All defaults")
  })

  test("names the fields that differ from their default", () => {
    expect(advancedSummary(advanced([
      field({ key: "model", label: "Agent model", kind: "text", value: "x/y", set: true, source: "db" }),
      field({ key: "name", label: "Bot name", kind: "text", value: "Bot", set: true, source: "db" }),
      field({ key: "url", label: "API base URL", kind: "text", value: "https://slack.com/api", set: true, default: "https://slack.com/api", source: "db" }),
    ]))).toBe("Agent model, Bot name changed")
  })
})

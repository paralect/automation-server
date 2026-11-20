import { describe, expect, test } from "bun:test"
import type { FieldView } from "@automation-server/api/routers/index"

import { buildPayload, initialState, isDirty, missingText } from "./settings-form"

const field = (over: Partial<FieldView> & Pick<FieldView, "key" | "kind">): FieldView => ({
  label: over.key,
  required: false,
  source: "default",
  set: false,
  ...over,
})

const fields: FieldView[] = [
  field({ key: "token", kind: "secret", set: true, source: "db" }),
  field({ key: "owner", kind: "text", value: "acme", source: "env" }),
  field({ key: "minCount", kind: "number", value: 3 }),
  field({ key: "enabled", kind: "boolean", value: false }),
  field({ key: "levels", kind: "list", value: ["error", "fatal"] }),
  field({ key: "users", kind: "slackUsers", value: ["U1", "U2"] }),
  field({ key: "channels", kind: "slackChannels" }),
]

describe("initialState", () => {
  test("never prefills secrets and joins lists", () => {
    expect(initialState(fields)).toEqual({ token: "", owner: "acme", minCount: "3", enabled: false, levels: "error\nfatal", users: "U1\nU2", channels: "" })
  })
})

describe("buildPayload", () => {
  const ok = (state: Record<string, string | boolean>, actions = {}) => {
    const r = buildPayload(fields, { ...initialState(fields), ...state }, actions)
    if (!r.ok) throw new Error(r.error)
    return r.payload
  }

  test("untouched form sends nothing, so an empty secret keeps the stored one", () => {
    const payload = ok({})
    expect(payload).toEqual({ values: {}, clear: [] })
    expect(isDirty(payload)).toBe(false)
  })

  test("typed secret is sent, Clear action removes it", () => {
    expect(ok({ token: "ghp_new" }).values).toEqual({ token: "ghp_new" })
    expect(ok({}, { token: "clear" }).clear).toEqual(["token"])
  })

  test("only changed fields are sent, typed per kind", () => {
    expect(ok({ owner: " other ", minCount: "10", enabled: true, levels: "a, b\nc" }).values).toEqual({
      owner: "other",
      minCount: 10,
      enabled: true,
      levels: ["a", "b", "c"],
    })
  })

  test("emptied optional fields are cleared to fall back to env or default", () => {
    expect(ok({ owner: "", minCount: "", levels: " \n" }).clear).toEqual(["owner", "minCount", "levels"])
  })

  test("rejects a non numeric number", () => {
    const r = buildPayload(fields, { ...initialState(fields), minCount: "abc" }, {})
    expect(r).toEqual({ ok: false, error: "minCount must be a number" })
  })
})

describe("slack list fields", () => {
  const build = (state: Record<string, string | boolean>) => {
    const r = buildPayload(fields, { ...initialState(fields), ...state }, {})
    if (!r.ok) throw new Error(r.error)
    return r.payload
  }

  test("a chosen list is sent as an array of ids", () => {
    expect(build({ users: "U1\nU2\nU3", channels: "C1" }).values).toEqual({ users: ["U1", "U2", "U3"], channels: ["C1"] })
  })

  test("an unchanged list sends nothing and a removed last id clears the field", () => {
    expect(build({})).toEqual({ values: {}, clear: [] })
    expect(build({ users: "" })).toEqual({ values: {}, clear: ["users"] })
  })
})

describe("missingText", () => {
  const labelled = [field({ key: "token", kind: "secret", label: "Token" }), field({ key: "repo", kind: "text", label: "Repository" })]

  test("names missing fields by label", () => {
    expect(missingText(["token", "repo"], labelled)).toBe("Missing: Token, Repository.")
    expect(missingText([], labelled)).toBeUndefined()
  })

  test("shows a sentence from the server as is", () => {
    expect(missingText(["Add the bot token and signing secret, or an alerts webhook URL."], labelled)).toBe("Add the bot token and signing secret, or an alerts webhook URL.")
  })
})

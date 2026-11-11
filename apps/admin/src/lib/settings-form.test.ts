import { describe, expect, test } from "bun:test"
import type { FieldView } from "@automation-server/api/routers/index"

import { buildPayload, initialState, isDirty } from "./settings-form"

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
]

describe("initialState", () => {
  test("never prefills secrets and joins lists", () => {
    expect(initialState(fields)).toEqual({ token: "", owner: "acme", minCount: "3", enabled: false, levels: "error\nfatal" })
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

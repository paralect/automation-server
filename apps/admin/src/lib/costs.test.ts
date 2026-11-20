import { describe, expect, test } from "bun:test"

import type { LlmTotals, MicroUsd } from "@automation-server/api/routers/index"

import { budgetMeter, costPerRun, formatMonth, recentMonths } from "./costs"

const usd = (dollars: number) => Math.round(dollars * 1_000_000) as MicroUsd
const totals = (dollars: number): LlmTotals => ({ calls: 1, promptTokens: 0, completionTokens: 0, cost: usd(dollars), unpriced: 0 })

describe("budgetMeter", () => {
  test("no budget, or a zero budget, has no meter", () => {
    expect(budgetMeter({ budget: null, totals: totals(5), projected: null })).toEqual({ kind: "none" })
    expect(budgetMeter({ budget: usd(0), totals: totals(5), projected: null })).toEqual({ kind: "none" })
  })

  test("the tone turns at 80% and again at 100%", () => {
    const tone = (spent: number) => {
      const meter = budgetMeter({ budget: usd(50), totals: totals(spent), projected: null })
      return meter.kind === "set" ? meter.tone : null
    }
    expect(tone(39.99)).toBe("ok")
    expect(tone(40)).toBe("warn")
    expect(tone(50)).toBe("over")
  })

  test("overspend or a higher projection widens the scale so markers stay on the bar", () => {
    const meter = budgetMeter({ budget: usd(50), totals: totals(25), projected: usd(100) })
    if (meter.kind !== "set") throw new Error("expected a meter")
    expect(meter.ratio).toBe(0.5)
    expect(meter.scale).toEqual({ spent: 0.25, projected: 1, at80: 0.4, at100: 0.5 })
  })
})

test("cost per run averages over runs, leaving out calls made outside a run", () => {
  expect(
    costPerRun([
      { ...totals(3), automation: "crisp-triage", runs: 2 },
      { ...totals(1), automation: "slack-bot", runs: 2 },
      { ...totals(10), automation: null, runs: 0 },
    ])
  ).toBe(usd(1))
  expect(costPerRun([{ ...totals(10), automation: null, runs: 0 }])).toBeNull()
})

test("months run newest first across a year boundary, in UTC", () => {
  expect(recentMonths(new Date("2026-02-15T12:00:00Z"), 4)).toEqual(["2026-02", "2026-01", "2025-12", "2025-11"])
  expect(formatMonth("2026-11")).toBe("November 2026")
})

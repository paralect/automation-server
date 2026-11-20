import type { CostMonth, MicroUsd } from "@automation-server/api/routers/index"

import { sumMicroUsd, splitMicroUsd } from "./format"

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

/** Ledger retention defaults to 400 days, so thirteen months back covers everything the server still holds. */
export const MONTHS_BACK = 13

export const monthOf = (date: Date) => date.toISOString().slice(0, 7)

/** "2026-11", newest first, starting at the month of `now` (UTC). */
export function recentMonths(now: Date, count = MONTHS_BACK) {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  return Array.from({ length: count }, (_, i) => monthOf(new Date(Date.UTC(year, month - i, 1))))
}

const MONTH_LABEL = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
const MONTH_SHORT = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" })

export const formatMonth = (month: string) => MONTH_LABEL.format(new Date(`${month}-01T00:00:00Z`))
export const formatMonthShort = (month: string) => MONTH_SHORT.format(new Date(`${month}-01T00:00:00Z`))

export type BudgetTone = "ok" | "warn" | "over"

export type BudgetMeter =
  | { kind: "none" }
  | {
      kind: "set"
      budget: MicroUsd
      spent: MicroUsd
      /** spent / budget, unclamped: 1.2 means 20% over. */
      ratio: number
      tone: BudgetTone
      /** Positions on the bar, 0..1, so the bar can show overspend without the fill running off its track. */
      scale: { spent: number; projected: number | null; at80: number; at100: number }
    }

export function budgetMeter(cost: Pick<CostMonth, "budget" | "totals" | "projected">): BudgetMeter {
  const { budget } = cost
  if (budget === null || budget <= 0) return { kind: "none" }
  const spent = cost.totals.cost
  const ratio = spent / budget
  const domain = Math.max(budget, spent, cost.projected ?? 0)
  return {
    kind: "set",
    budget,
    spent,
    ratio,
    tone: ratio >= 1 ? "over" : ratio >= 0.8 ? "warn" : "ok",
    scale: {
      spent: spent / domain,
      projected: cost.projected === null ? null : cost.projected / domain,
      at80: (budget * 0.8) / domain,
      at100: budget / domain,
    },
  }
}

/** Average over runs that made at least one LLM call; calls outside a run have no run to average over. */
export function costPerRun(byAutomation: CostMonth["byAutomation"]): MicroUsd | null {
  const inRuns = byAutomation.filter((row) => row.automation !== null)
  const runs = inRuns.reduce((n, row) => n + row.runs, 0)
  return runs === 0 ? null : splitMicroUsd(sumMicroUsd(inRuns.map((row) => row.cost)), runs)
}

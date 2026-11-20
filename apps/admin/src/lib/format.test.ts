import { describe, expect, test } from "bun:test"

import type { MicroUsd } from "@automation-server/api/routers/index"

import { formatCompact, formatHours, formatPercent, formatUsd, formatUsdAxis, splitMicroUsd } from "./format"

const usd = (dollars: number) => Math.round(dollars * 1_000_000) as MicroUsd

describe("formatUsd", () => {
  test("a dollar and up shows cents", () => {
    expect(formatUsd(usd(31.4))).toBe("$31.40")
    expect(formatUsd(usd(1234.5))).toBe("$1,234.50")
    expect(formatUsd(usd(0))).toBe("$0.00")
  })

  test("below a dollar keeps two significant digits instead of rounding to zero", () => {
    expect(formatUsd(usd(0.4))).toBe("$0.40")
    expect(formatUsd(usd(0.0132))).toBe("$0.013")
    expect(formatUsd(usd(0.000412))).toBe("$0.00041")
    expect(formatUsd(usd(0.000001))).toBe("$0.000001")
  })

  test("axis ticks drop cents from ten dollars up", () => {
    expect(formatUsdAxis(0)).toBe("$0")
    expect(formatUsdAxis(2.5)).toBe("$2.50")
    expect(formatUsdAxis(40)).toBe("$40")
  })
})

test("a share of an amount rounds to whole micro-dollars", () => {
  expect(splitMicroUsd(usd(1), 3)).toBe(usd(0.333333))
})

test("durations read in minutes under an hour, hours under a day, days after", () => {
  expect(formatHours(0.004)).toBe("1 min")
  expect(formatHours(0.5)).toBe("30 min")
  expect(formatHours(6.46)).toBe("6.5 h")
  expect(formatHours(19.5)).toBe("20 h")
  expect(formatHours(42)).toBe("1.8 d")
  expect(formatHours(24 * 12)).toBe("12 d")
})

test("a missing rate is a dash and counts go compact only from ten thousand", () => {
  expect(formatPercent(null)).toBe("-")
  expect(formatPercent(0.719)).toBe("72%")
  expect(formatCompact(4100)).toBe("4,100")
  expect(formatCompact(128_400)).toBe("128.4K")
})

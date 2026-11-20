import type { MicroUsd } from "@automation-server/api/routers/index"

const MICRO_PER_USD = 1_000_000
const HOUR_MS = 3_600_000

export const toUsd = (amount: MicroUsd) => amount / MICRO_PER_USD

// Sums and shares of amounts stay amounts, so these are the only places a number becomes MicroUsd.
export const sumMicroUsd = (amounts: readonly MicroUsd[]) => amounts.reduce((a, b) => a + b, 0) as MicroUsd
export const splitMicroUsd = (amount: MicroUsd, parts: number) => Math.round(amount / parts) as MicroUsd

const usd = (fractionDigits: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })

const USD_CENTS = usd(2)
const USD_WHOLE = usd(0)

// One LLM call often costs a fraction of a cent, so below a dollar keep two significant digits instead of rounding to $0.00.
export function formatUsd(amount: MicroUsd) {
  const value = toUsd(amount)
  const abs = Math.abs(value)
  if (abs === 0 || abs >= 1) return USD_CENTS.format(value)
  const digits = Math.min(6, Math.max(2, 1 - Math.floor(Math.log10(abs))))
  return usd(digits).format(value)
}

export const formatUsdAxis = (usdValue: number) => (usdValue >= 10 || usdValue === 0 ? USD_WHOLE : USD_CENTS).format(usdValue)

const COUNT = new Intl.NumberFormat("en-US")
const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })

export const formatCount = (n: number) => COUNT.format(n)
export const formatCompact = (n: number) => (Math.abs(n) < 10_000 ? COUNT.format(n) : COMPACT.format(n))

export const formatPercent = (rate: number | null) => (rate === null ? "-" : `${Math.round(rate * 100)}%`)

const oneDecimalBelowTen = (n: number) => (n < 10 ? String(Math.round(n * 10) / 10) : String(Math.round(n)))

export function formatHours(hours: number) {
  if (hours < 0) return "0 min"
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`
  if (hours < 24) return `${oneDecimalBelowTen(hours)} h`
  return `${oneDecimalBelowTen(hours / 24)} d`
}

export const hoursBetween = (fromIso: string, toIso: string) => (Date.parse(toIso) - Date.parse(fromIso)) / HOUR_MS

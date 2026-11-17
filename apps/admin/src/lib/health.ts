import type { IntegrationView } from "@automation-server/api/routers/index"

export const EXPIRY_WARNING_DAYS = 14

const DAY_MS = 86_400_000

export type HealthDot = "ok" | "failed" | "unknown"

export type ExpiryState =
  | { kind: "none" }
  | { kind: "expired" }
  | { kind: "expiring"; days: number; warning: boolean }

export function expiryState(expiresAt: string | undefined, now: Date): ExpiryState {
  const at = expiresAt ? Date.parse(expiresAt) : NaN
  if (Number.isNaN(at)) return { kind: "none" }
  const left = at - now.getTime()
  if (left <= 0) return { kind: "expired" }
  const days = Math.ceil(left / DAY_MS)
  return { kind: "expiring", days, warning: days <= EXPIRY_WARNING_DAYS }
}

export function expiryLabel(state: ExpiryState): string | undefined {
  if (state.kind === "expired") return "Expired"
  if (state.kind === "expiring") return `Expires in ${state.days} ${state.days === 1 ? "day" : "days"}`
  return undefined
}

export const healthDot = (health: IntegrationView["health"]): HealthDot =>
  !health ? "unknown" : health.ok ? "ok" : "failed"

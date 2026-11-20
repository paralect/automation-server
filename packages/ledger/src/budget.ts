import { microUsd } from "./facts";
import { BUDGET_THRESHOLDS_PCT, type BudgetThresholdPct, type MicroUsd } from "./types";

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

// UTC "YYYY-MM".
export const monthOf = (at: Date): string => at.toISOString().slice(0, 7);

export function monthBounds(month: string): { readonly start: Date; readonly end: Date } {
  const match = MONTH.exec(month);
  if (!match) throw new Error(`invalid month: ${month}`);
  const year = Number(match[1]);
  const index = Number(match[2]) - 1;
  return { start: new Date(Date.UTC(year, index, 1)), end: new Date(Date.UTC(year, index + 1, 1)) };
}

// Thresholds are level-triggered: every reached one is returned, and the alert store makes each fire once a month.
export function reachedThresholds(spent: MicroUsd, budget: MicroUsd): BudgetThresholdPct[] {
  if (budget <= 0) return [];
  return BUDGET_THRESHOLDS_PCT.filter((pct) => spent * 100 >= budget * pct);
}

// Spend so far times days in the month over days elapsed, today counted. Only the current month has a projection.
export function projectedSpend(spent: MicroUsd, month: string, now: Date): MicroUsd | null {
  if (monthOf(now) !== month || spent === 0) return null;
  const { start, end } = monthBounds(month);
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  return microUsd(Math.round((spent * days) / now.getUTCDate()));
}

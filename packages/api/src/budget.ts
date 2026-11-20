import { toMicroUsd, type MicroUsd } from "@automation-server/ledger";
import type { ResolvedConfig } from "@automation-server/settings";

// The project's monthly LLM budget from settings, or null when it is off (0 or unset).
export function monthlyBudget(config: ResolvedConfig): MicroUsd | null {
  const usd = config.openrouter.values.monthlyBudgetUsd;
  return typeof usd === "number" && usd > 0 ? toMicroUsd(usd) : null;
}

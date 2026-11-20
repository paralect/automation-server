import { monthlyBudget } from "@automation-server/api/budget";
import { errorMessage } from "@automation-server/api/errors";
import { escapeSlackText, postToSlack } from "@automation-server/automations";
import type { Logger } from "@automation-server/core";
import { MICROS_PER_USD, monthOf, reachedThresholds, type BudgetAlertPort, type BudgetThresholdPct, type MicroUsd } from "@automation-server/ledger";
import type { ResolvedConfig } from "@automation-server/settings";

export type BudgetAlerter = { check(project: string, now: Date): Promise<void> };

export type BudgetAlerterDeps = {
  ledger: BudgetAlertPort;
  resolve: (project: string) => ResolvedConfig;
  log: Logger;
  fetch?: typeof fetch;
  adminUrl?: string;
};

const dollars = (amount: MicroUsd) => `$${(amount / MICROS_PER_USD).toFixed(2)}`;

// Level-triggered: every check sends each reached threshold that has no alert this month yet. The claim row makes that
// exactly once across concurrent checks and restarts; a failed post releases it so the next LLM call retries.
// Raising the budget mid-month does not re-arm a threshold already sent, because the row is keyed by month, not amount.
export function createBudgetAlerter({ ledger, resolve, log, fetch, adminUrl }: BudgetAlerterDeps): BudgetAlerter {
  const message = (project: string, pct: BudgetThresholdPct, spent: MicroUsd, budget: MicroUsd, month: string) => {
    const lines = [`:moneybag: LLM spend for project \`${escapeSlackText(project)}\` reached ${pct}% of the ${dollars(budget)} monthly budget (${dollars(spent)} in ${month})`];
    if (adminUrl) lines.push(`Costs: ${adminUrl}/costs`);
    return lines.join("\n");
  };

  return {
    async check(project, now) {
      try {
        const config = resolve(project);
        const budget = monthlyBudget(config);
        const { webhookUrl } = config.slack.values;
        if (budget === null || !webhookUrl) return;
        const month = monthOf(now);
        const spent = ledger.monthSpend(project, month);
        for (const pct of reachedThresholds(spent, budget)) {
          if (!ledger.claimAlert(project, month, pct, now)) continue;
          try {
            await postToSlack(webhookUrl, message(project, pct, spent, budget, month), { fetch });
          } catch (err) {
            ledger.releaseAlert(project, month, pct);
            log.warn("budget alert failed", { project, month, thresholdPct: pct, error: errorMessage(err) });
            continue;
          }
          ledger.markAlertSent(project, month, pct, now);
          log.info("budget alert sent", { project, month, thresholdPct: pct });
        }
      } catch (err) {
        log.warn("budget check failed", { project, error: errorMessage(err) });
      }
    },
  };
}

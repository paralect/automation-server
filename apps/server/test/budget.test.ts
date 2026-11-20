import type { Logger } from "@automation-server/core";
import { toMicroUsd, type BudgetAlertPort, type LlmCall } from "@automation-server/ledger";
import { createSqliteLedger } from "@automation-server/ledger/server";
import { createSqliteSettingsStore, resolveConfig } from "@automation-server/settings";
import { describe, expect, test } from "bun:test";

import { createBudgetAlerter } from "../src/budget";

const HOOK = "https://hooks.slack.com/services/T000/B000/SECRETSECRET";
const PROJECT = "acme";
const NOV = new Date("2026-11-20T12:00:00.000Z");
const quiet: Logger = { info() {}, warn() {}, error() {} };

const call = (usd: number, at = NOV.toISOString()): LlmCall => ({
  provider: "openrouter",
  model: "anthropic/claude-haiku-5.5",
  purpose: "triage",
  generationId: null,
  promptTokens: 10,
  completionTokens: 1,
  cost: toMicroUsd(usd),
  at,
  durationMs: 5,
});

const setup = ({ budgetUsd = 50, webhook = true, markSentFails = false }: { budgetUsd?: number; webhook?: boolean; markSentFails?: boolean } = {}) => {
  const slack = { status: 200, gate: null as Promise<void> | null };
  const posted: string[] = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    posted.push((JSON.parse(String(init?.body)) as { text: string }).text);
    if (slack.gate) await slack.gate;
    return new Response(slack.status === 200 ? "ok" : "no", { status: slack.status });
  }) as typeof globalThis.fetch;
  const settings = createSqliteSettingsStore({ path: ":memory:", encryptionKey: "k" });
  settings.project(PROJECT).apply({ set: [{ key: "openrouter.monthlyBudgetUsd", json: String(budgetUsd), secret: false }] });
  const env = webhook ? { SLACK_ALERTS_WEBHOOK_URL: HOOK } : {};
  const ledger = createSqliteLedger({ path: ":memory:" });
  const port: BudgetAlertPort = {
    monthSpend: (project, month) => ledger.monthSpend(project, month),
    claimAlert: (project, month, pct, at) => ledger.claimAlert(project, month, pct, at),
    markAlertSent: (project, month, pct, at) => {
      if (markSentFails) throw new Error("SQLITE_BUSY: database is locked");
      ledger.markAlertSent(project, month, pct, at);
    },
    releaseAlert: (project, month, pct) => ledger.releaseAlert(project, month, pct),
  };
  const budget = createBudgetAlerter({ ledger: port, resolve: (p) => resolveConfig(settings.project(p), env), log: quiet, fetch, adminUrl: "https://admin.example.com" });
  const spend = (usd: number, at?: string) => ledger.recordLlmCall(PROJECT, null, call(usd, at));
  return { slack, posted, ledger, budget, spend, settings };
};

describe("budget alerts", () => {
  test("each threshold alerts exactly once a month, however many checks follow", async () => {
    const t = setup();
    t.spend(39);
    await t.budget.check(PROJECT, NOV);
    expect(t.posted).toEqual([]);

    t.spend(1.5);
    await t.budget.check(PROJECT, NOV);
    await t.budget.check(PROJECT, NOV);
    expect(t.posted).toEqual([
      ":moneybag: LLM spend for project `acme` reached 80% of the $50.00 monthly budget ($40.50 in 2026-11)\nCosts: https://admin.example.com/costs",
    ]);

    t.spend(10);
    await t.budget.check(PROJECT, NOV);
    await t.budget.check(PROJECT, NOV);
    expect(t.posted).toHaveLength(2);
    expect(t.posted[1]).toContain("reached 100% of the $50.00 monthly budget ($50.50 in 2026-11)");
    expect(t.ledger.costs(PROJECT, "2026-11", null, NOV).alerts.map((a) => a.thresholdPct)).toEqual([80, 100]);

    const dec = new Date("2026-12-02T09:00:00.000Z");
    t.spend(45, dec.toISOString());
    await t.budget.check(PROJECT, dec);
    expect(t.posted).toHaveLength(3);
    expect(t.posted[2]).toContain("reached 80%");
    expect(t.posted[2]).toContain("in 2026-12");
  });

  test("two checks racing past a threshold post one alert", async () => {
    const t = setup();
    t.spend(45);
    let open = () => {};
    t.slack.gate = new Promise((resolve) => (open = resolve));
    const first = t.budget.check(PROJECT, NOV);
    const second = t.budget.check(PROJECT, NOV);
    open();
    await Promise.all([first, second]);
    expect(t.posted).toHaveLength(1);
  });

  test("a failed Slack post is retried by the next check, and stops once it went through", async () => {
    const t = setup();
    t.spend(45);
    t.slack.status = 500;
    await t.budget.check(PROJECT, NOV);
    expect(t.ledger.costs(PROJECT, "2026-11", null, NOV).alerts).toEqual([]);
    t.slack.status = 200;
    await t.budget.check(PROJECT, NOV);
    await t.budget.check(PROJECT, NOV);
    expect(t.posted).toHaveLength(2);
    expect(t.ledger.costs(PROJECT, "2026-11", null, NOV).alerts.map((a) => a.thresholdPct)).toEqual([80]);
  });

  test("an alert that reached Slack is never sent again, even when recording it as sent fails", async () => {
    const t = setup({ markSentFails: true });
    t.spend(52);
    await t.budget.check(PROJECT, NOV);
    expect(t.posted).toHaveLength(2);
    await t.budget.check(PROJECT, new Date(NOV.getTime() + 10 * 60_000));
    await t.budget.check(PROJECT, new Date(NOV.getTime() + 86_400_000));
    expect(t.posted).toHaveLength(2);
  });

  test("raising the budget mid-month does not re-arm a threshold already sent", async () => {
    const t = setup();
    t.spend(45);
    await t.budget.check(PROJECT, NOV);
    t.settings.project(PROJECT).apply({ set: [{ key: "openrouter.monthlyBudgetUsd", json: "55", secret: false }] });
    await t.budget.check(PROJECT, NOV);
    expect(t.posted).toHaveLength(1);
  });

  test("no budget or no alerts webhook means no alert, and spend is still counted", async () => {
    for (const t of [setup({ budgetUsd: 0 }), setup({ webhook: false })]) {
      t.spend(1000);
      await t.budget.check(PROJECT, NOV);
      expect(t.posted).toEqual([]);
      expect(t.ledger.monthSpend(PROJECT, "2026-11")).toBe(toMicroUsd(1000));
    }
  });
});

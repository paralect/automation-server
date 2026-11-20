// Seeds a database with 90 days of Codex PR outcomes, workflow runs, run chains and two months of LLM spend, so the
// Outcomes, Costs and run pages can be tried and screenshotted without live traffic. Safe to run again: every row has a
// natural key (PR number, run id, generation id) or is skipped when its demo run already has one.
//
//   DATABASE_PATH=./data/demo.db bun apps/server/scripts/demo-ledger.ts
import { createSqliteActivityStore, type Event } from "@automation-server/core";
import { parseRepoName, reachedThresholds, toMicroUsd, workKey, type LlmCall, type PullRequestLifecycle, type PullRequestRecord, type RecordScope, type WorkflowRunRecord, type WorkKey } from "@automation-server/ledger";
import { createSqliteLedger } from "@automation-server/ledger/server";
import { createSqliteSettingsStore } from "@automation-server/settings";

const path = process.env.DATABASE_PATH;
if (!path) throw new Error("DATABASE_PATH is required");
const project = process.env.DEMO_PROJECT ?? "default";
const repo = parseRepoName(process.env.DEMO_REPO ?? "acme/app");
if (!repo) throw new Error("DEMO_REPO must be owner/name");

const BUDGET_USD = 12;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Runs older than this would be pruned by LOG_RETENTION_DAYS at the next start, so older chains point at pruned runs, as they would in production.
const RUN_DAYS = 25;
const now = Date.now();
const iso = (t: number) => new Date(t).toISOString();

// Seeded, so a second run produces the same rows and the upserts change nothing.
let seed = 20261120;
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(items: readonly [T, ...T[]]): T => items[Math.floor(random() * items.length)] ?? items[0];

const activity = createSqliteActivityStore({ path });
const ledger = createSqliteLedger({ path });
const settings = createSqliteSettingsStore({ path });

if (!("openrouter.monthlyBudgetUsd" in settings.project(project).all())) {
  settings.project(project).apply({ set: [{ key: "openrouter.monthlyBudgetUsd", json: String(BUDGET_USD), secret: false }] });
}

const runFor = (automation: string, source: string, kind: string, externalId: string, startedAt: number, event?: Event): string | null => {
  if (now - startedAt > RUN_DAYS * DAY) return null;
  const existing = activity.queryRuns({ project, automation, search: externalId, limit: 1 }).items[0];
  if (existing) return existing.id;
  const id = activity.startRun({ project, automation, source, kind, externalId, startedAt: iso(startedAt), ...(event ? { event } : {}) });
  activity.finishRun(id, { status: "succeeded", finishedAt: iso(startedAt + 40_000) });
  return id;
};

const sentryEvent = (issueId: string, at: number): Event => ({
  project,
  source: "sentry",
  kind: "issue_alert",
  externalId: issueId,
  receivedAt: iso(at),
  payload: { issueId, title: "TypeError: Cannot read properties of undefined (reading 'total')", level: "error", eventWebUrl: null, issue: { count: 12, firstSeen: iso(at - DAY), lastSeen: iso(at), permalink: `https://acme.sentry.io/issues/${issueId}/` } },
});

const TITLES = [
  "Checkout crashes when the cart is empty",
  "Invoice PDF shows the wrong currency",
  "Password reset email links to staging",
  "Search returns archived projects",
  "Timezone shifts due dates by one day",
  "CSV export drops the last row",
  "Avatar upload fails for HEIC images",
  "Webhook retries never stop after a 410",
  "Dashboard chart ignores the date filter",
  "Mobile menu does not close after navigation",
] as const;

type Origin = "sentry-to-github-issue" | "crisp-triage" | "linear-label-to-pr" | "manual" | "codex-seo-autopilot" | "codex-changelog";
const ORIGINS = ["sentry-to-github-issue", "crisp-triage", "crisp-triage", "linear-label-to-pr", "linear-label-to-pr", "manual", "codex-seo-autopilot", "codex-changelog"] as const satisfies readonly Origin[];

const pullRequests: PullRequestRecord[] = [];
const workflowRuns: WorkflowRunRecord[] = [];
let issueNumber = 400;
let prNumber = 900;
let runId = 7_000_000_000;

const lifecycleFor = (opened: number): PullRequestLifecycle => {
  const age = now - opened;
  const roll = random();
  if (age < 2 * DAY && roll < 0.7) return { state: "open", draft: random() < 0.6 };
  if (roll < 0.62) return { state: "merged", mergedAt: iso(Math.min(now - HOUR, opened + (2 + random() * 70) * HOUR)) };
  if (roll < 0.85) return { state: "closed", closedAt: iso(Math.min(now - HOUR, opened + (4 + random() * 100) * HOUR)) };
  return { state: "open", draft: random() < 0.4 };
};

const issueCreated = (scope: RecordScope, key: WorkKey, url: string, at: number) => ledger.recordEffect(project, scope, { kind: "issue_created", repo, workKey: key, url, at: iso(at) });
const dispatched = (scope: RecordScope, key: WorkKey, url: string | null, workflowFile: string, workflowRunId: number, at: number) =>
  ledger.recordEffect(project, scope, { kind: "workflow_dispatched", repo, workKey: key, url, workflowFile, ref: "main", workflowRunId, at: iso(at) });

for (let day = 90; day >= 0; day -= 2) {
  const origin = pick(ORIGINS);
  const t0 = now - day * DAY - random() * 20 * HOUR;
  const title = pick(TITLES);
  const id = ++runId;

  if (origin === "codex-seo-autopilot" || origin === "codex-changelog") {
    const seo = origin === "codex-seo-autopilot";
    workflowRuns.push({ repo, id, producer: origin, runNumber: id % 1000, title: seo ? "Codex SEO autopilot" : "Codex changelog", state: "success", createdAt: iso(t0), url: `https://github.com/${repo}/actions/runs/${id}`, link: null });
    pullRequests.push({
      repo,
      number: ++prNumber,
      producer: origin,
      workKey: null,
      title: seo ? `SEO autopilot ${iso(t0).slice(0, 10)}` : `Changelog for production @ ${id.toString(16).slice(-7)}`,
      url: `https://github.com/${repo}/pull/${prNumber}`,
      createdAt: iso(t0 + 25 * 60_000),
      lifecycle: lifecycleFor(t0),
    });
    continue;
  }

  const linear = origin === "linear-label-to-pr";
  const identifier = `ENG-${100 + Math.floor(day * 1.7)}`;
  const number = ++issueNumber;
  const key = linear ? workKey({ kind: "linear-issue", identifier }) : workKey({ kind: "github-issue", repo, number });
  const issueUrl = linear ? `https://linear.app/acme/issue/${identifier}` : `https://github.com/${repo}/issues/${number}`;
  const workflowFile = linear ? "linear-implement.yml" : "codex-issue-fix.yml";
  const producer = linear ? "linear-implement" : "codex-issue-fix";

  if (origin !== "manual") {
    const externalId = origin === "sentry-to-github-issue" ? `demo-sentry-${number}` : origin === "crisp-triage" ? `demo-session-${number}:triage` : `demo-${identifier}`;
    const source = origin === "sentry-to-github-issue" ? "sentry" : origin === "crisp-triage" ? "crisp" : "linear";
    const run = runFor(origin, source, origin === "sentry-to-github-issue" ? "issue_alert" : "event", externalId, t0, origin === "sentry-to-github-issue" ? sentryEvent(`demo-sentry-${number}`, t0) : undefined);
    const scope: RecordScope = { runId: run ?? `demo-pruned-${number}`, automation: origin, dryRun: false };
    if (ledger.trace(project, scope.runId ?? "", new Date(now)).workItems.length === 0) {
      if (origin !== "linear-label-to-pr") issueCreated(scope, key, issueUrl, t0);
      // Sentry issues are fixed by a person starting the workflow, so only crisp and Linear dispatch.
      if (origin !== "sentry-to-github-issue") dispatched(scope, key, linear ? issueUrl : null, workflowFile, id, t0 + 2_000);
    }
    const escalated = random() < 0.5;
    if (origin === "crisp-triage" && run) {
      for (const [i, model] of ["anthropic/claude-haiku-5.5", ...(escalated ? ["anthropic/claude-sonnet-5.5"] : [])].entries()) {
        ledger.recordLlmCall(project, scope, llm(`demo-crisp-${number}-${i}`, model, "triage", t0 + i * 3_000));
      }
    }
  }

  const failed = random() < 0.12;
  workflowRuns.push({
    repo,
    id,
    producer,
    runNumber: id % 1000,
    title: linear ? `Linear implement ${identifier}` : `Codex issue fix #${number}`,
    state: failed ? "failure" : "success",
    createdAt: iso(t0 + 5_000),
    url: `https://github.com/${repo}/actions/runs/${id}`,
    link: { workKey: key, match: origin === "manual" || origin === "sentry-to-github-issue" ? "titled" : "exact" },
  });
  if (failed) continue;
  pullRequests.push({
    repo,
    number: ++prNumber,
    producer,
    workKey: key,
    title: linear ? `${identifier}: ${title}` : title,
    url: `https://github.com/${repo}/pull/${prNumber}`,
    createdAt: iso(t0 + 18 * 60_000),
    lifecycle: lifecycleFor(t0),
  });
}

function llm(generationId: string, model: string, purpose: string, at: number): LlmCall {
  const sonnet = model.includes("sonnet");
  const promptTokens = Math.round(1500 + random() * 6000);
  const completionTokens = Math.round(80 + random() * 600);
  const usd = (promptTokens * (sonnet ? 3 : 1) + completionTokens * (sonnet ? 15 : 5)) / 1_000_000;
  return { provider: "openrouter", model, purpose, generationId, promptTokens, completionTokens, cost: toMicroUsd(usd * 6), at: iso(at), durationMs: Math.round(800 + random() * 4000) };
}

// Slack bot conversations: several agent steps per run, across this month and the last.
for (let day = 45; day >= 0; day--) {
  const at = now - day * DAY - random() * 10 * HOUR;
  const run = runFor("slack-bot", "slack", "app_mention", `demo-thread-${day}`, at);
  const scope: RecordScope | null = run ? { runId: run, automation: "slack-bot", dryRun: false } : null;
  const steps = 2 + Math.floor(random() * 5);
  for (let step = 0; step < steps; step++) ledger.recordLlmCall(project, scope, llm(`demo-slack-${day}-${step}`, "anthropic/claude-sonnet-5.5", "agent_step", at + step * 4_000));
  if (day % 9 === 0) ledger.recordLlmCall(project, null, { ...llm(`demo-unpriced-${day}`, "anthropic/claude-haiku-5.5", "triage", at), cost: null });
}

ledger.applyRepoSync({ project, repo, pullRequests, workflowRuns, prCursor: iso(now - HOUR), syncedAt: iso(now - 12 * 60_000) });

const month = iso(now).slice(0, 7);
const spent = ledger.monthSpend(project, month);
for (const pct of reachedThresholds(spent, toMicroUsd(BUDGET_USD))) {
  if (ledger.claimAlert(project, month, pct, new Date(now))) ledger.markAlertSent(project, month, pct, new Date(now));
}

const costs = ledger.costs(project, month, toMicroUsd(BUDGET_USD), new Date(now));
const outcomes = ledger.outcomes(project, 90, new Date(now));
console.log(
  JSON.stringify({
    database: path,
    project,
    repo,
    pullRequests: pullRequests.length,
    workflowRuns: workflowRuns.length,
    outcomes90d: outcomes.overall,
    month,
    llmCalls: costs.totals.calls,
    spendUsd: costs.totals.cost / 1_000_000,
  }),
);

ledger.close();
activity.close();
settings.close();

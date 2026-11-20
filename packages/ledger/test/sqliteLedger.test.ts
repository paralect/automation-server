import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { microUsd, toMicroUsd } from "../src/facts";
import type { RecordScope, RepoSyncBatch, StoredEffect } from "../src/ports";
import { createSqliteLedger } from "../src/sqliteLedger";
import type { WorkflowRunRecord } from "../src/types";
import { workKey } from "../src/workKey";
import { APP, issueKey, llmCall, pullRequest } from "./fixtures";

const NOW = new Date("2026-11-20T12:00:00.000Z");
const P = "default";
const crispRun: RecordScope = { runId: "run-crisp", automation: "crisp-triage", dryRun: false };

const issueCreated = (number: number, at = "2026-11-10T09:00:00.000Z"): StoredEffect => ({
  kind: "issue_created",
  repo: APP,
  workKey: issueKey(number),
  url: `https://github.com/acme/app/issues/${number}`,
  at,
});
const dispatched = (number: number, at = "2026-11-10T09:00:01.000Z", workflowRunId: number | null = null): StoredEffect => ({
  kind: "workflow_dispatched",
  repo: APP,
  workKey: issueKey(number),
  url: null,
  workflowFile: "codex-issue-fix.yml",
  ref: "main",
  workflowRunId,
  at,
});

const workflowRun = (id: number, number: number | null, createdAt = "2026-11-10T09:00:05.000Z"): WorkflowRunRecord => ({
  repo: APP,
  id,
  producer: "codex-issue-fix",
  runNumber: id,
  title: number === null ? "Fix issue with Codex" : `Codex issue fix #${number}`,
  state: "success",
  createdAt,
  url: `https://github.com/acme/app/actions/runs/${id}`,
  link: number === null ? null : { workKey: issueKey(number), match: "titled" },
});

const batch = (overrides: Partial<RepoSyncBatch>): RepoSyncBatch => ({
  project: P,
  repo: APP,
  pullRequests: [],
  workflowRuns: [],
  prCursor: "2026-11-20T11:00:00.000Z",
  syncedAt: "2026-11-20T11:30:00.000Z",
  ...overrides,
});

describe("sqlite ledger: LLM calls", () => {
  test("a call recorded twice with the same generation id is stored once; unpriced calls count but add nothing", () => {
    const ledger = createSqliteLedger({ path: ":memory:" });
    ledger.recordLlmCall(P, crispRun, llmCall({ generationId: "gen-1", usd: 0.012 }));
    ledger.recordLlmCall(P, crispRun, llmCall({ generationId: "gen-1", usd: 0.012 }));
    ledger.recordLlmCall(P, crispRun, llmCall({ generationId: null, usd: 0.003, model: "anthropic/claude-sonnet-5.5" }));
    ledger.recordLlmCall(P, crispRun, llmCall({ generationId: null, usd: null }));

    const trace = ledger.trace(P, "run-crisp", NOW);
    expect(trace.llm.totals).toEqual({ calls: 3, promptTokens: 3000, completionTokens: 300, cost: toMicroUsd(0.015), unpriced: 1 });
    expect(trace.llm.calls[0]).toMatchObject({ runId: "run-crisp", automation: "crisp-triage", dryRun: false, generationId: "gen-1", cost: toMicroUsd(0.012) });
    expect(ledger.monthSpend(P, "2026-11")).toBe(toMicroUsd(0.015));
    expect(ledger.monthSpend("other", "2026-11")).toBe(microUsd(0));
  });

  test("month cost report: per automation (outside a run included), per model, zero-filled days, top runs, sent alerts", () => {
    const ledger = createSqliteLedger({ path: ":memory:" });
    ledger.recordLlmCall(P, crispRun, llmCall({ usd: 0.5, at: "2026-11-02T10:00:00.000Z" }));
    ledger.recordLlmCall(P, crispRun, llmCall({ usd: 0.25, at: "2026-11-02T11:00:00.000Z", model: "anthropic/claude-sonnet-5.5" }));
    ledger.recordLlmCall(P, { runId: "run-bot", automation: "slack-bot", dryRun: false }, llmCall({ usd: 1, at: "2026-11-05T10:00:00.000Z" }));
    ledger.recordLlmCall(P, null, llmCall({ usd: 0.1, at: "2026-11-05T12:00:00.000Z" }));
    ledger.recordLlmCall(P, crispRun, llmCall({ usd: 9, at: "2026-10-31T23:59:59.000Z" }));
    expect(ledger.claimAlert(P, "2026-11", 80, NOW)).toBe(true);
    ledger.markAlertSent(P, "2026-11", 80, NOW);

    const month = ledger.costs(P, "2026-11", toMicroUsd(2), NOW);
    expect(month.totals).toEqual({ calls: 4, promptTokens: 4000, completionTokens: 400, cost: toMicroUsd(1.85), unpriced: 0 });
    expect(month.budget).toBe(toMicroUsd(2));
    expect(month.projected).toBe(microUsd(Math.round((1_850_000 * 30) / 20)));
    expect(month.alerts).toEqual([{ thresholdPct: 80, sentAt: NOW.toISOString() }]);
    expect(month.byAutomation.map((a) => [a.automation, a.runs, a.calls, a.cost])).toEqual([
      ["slack-bot", 1, 1, toMicroUsd(1)],
      ["crisp-triage", 1, 2, toMicroUsd(0.75)],
      [null, 0, 1, toMicroUsd(0.1)],
    ]);
    expect(month.byModel.map((m) => [m.model, m.calls])).toEqual([
      ["anthropic/claude-haiku-5.5", 3],
      ["anthropic/claude-sonnet-5.5", 1],
    ]);
    expect(month.daily).toHaveLength(20);
    expect(month.daily[0]).toEqual({ day: "2026-11-01", cost: microUsd(0) });
    expect(month.daily[1]).toEqual({ day: "2026-11-02", cost: toMicroUsd(0.75) });
    expect(month.topRuns.map((r) => [r.runId, r.calls, r.cost])).toEqual([
      ["run-bot", 1, toMicroUsd(1)],
      ["run-crisp", 2, toMicroUsd(0.75)],
    ]);

    const past = ledger.costs(P, "2026-10", null, NOW);
    expect(past.daily).toHaveLength(31);
    expect(past.projected).toBeNull();
    expect(past.totals.cost).toBe(toMicroUsd(9));
  });
});

describe("sqlite ledger: budget alert claims", () => {
  test("one claim per threshold and month; a release lets the next check retry; a sent alert stays sent", () => {
    const ledger = createSqliteLedger({ path: ":memory:" });
    expect(ledger.claimAlert(P, "2026-11", 80, NOW)).toBe(true);
    expect(ledger.claimAlert(P, "2026-11", 80, NOW)).toBe(false);
    ledger.releaseAlert(P, "2026-11", 80);
    expect(ledger.claimAlert(P, "2026-11", 80, NOW)).toBe(true);
    ledger.markAlertSent(P, "2026-11", 80, NOW);
    ledger.releaseAlert(P, "2026-11", 80);
    expect(ledger.claimAlert(P, "2026-11", 80, new Date(NOW.getTime() + 86_400_000))).toBe(false);
    expect(ledger.claimAlert(P, "2026-11", 100, NOW)).toBe(true);
    expect(ledger.claimAlert(P, "2026-12", 80, NOW)).toBe(true);
  });

  test("a pending claim left by a crash is taken over after the five-minute lease", () => {
    const ledger = createSqliteLedger({ path: ":memory:" });
    expect(ledger.claimAlert(P, "2026-11", 100, NOW)).toBe(true);
    expect(ledger.claimAlert(P, "2026-11", 100, new Date(NOW.getTime() + 4 * 60_000))).toBe(false);
    expect(ledger.claimAlert(P, "2026-11", 100, new Date(NOW.getTime() + 6 * 60_000))).toBe(true);
  });
});

describe("sqlite ledger: sync and the run chain", () => {
  test("applying the same sync twice changes nothing, and a later state updates the same row", () => {
    const ledger = createSqliteLedger({ path: ":memory:" });
    const open = batch({ pullRequests: [pullRequest(12, { state: "open", draft: true })], workflowRuns: [workflowRun(500, 12)] });
    ledger.applyRepoSync(open);
    ledger.applyRepoSync(open);
    const first = ledger.pullRequests({ project: P, limit: 10 });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.lifecycle).toEqual({ state: "open", draft: true });

    ledger.applyRepoSync(batch({ pullRequests: [pullRequest(12, { state: "merged", mergedAt: "2026-11-11T10:00:00.000Z" })], prCursor: null }));
    const after = ledger.pullRequests({ project: P, limit: 10 }).items;
    expect(after).toHaveLength(1);
    expect(after[0]?.seq).toBe(first.items[0]?.seq ?? -1);
    expect(after[0]?.lifecycle).toEqual({ state: "merged", mergedAt: "2026-11-11T10:00:00.000Z" });
    expect(ledger.syncState(P, APP)).toEqual({ prCursor: "2026-11-20T11:00:00.000Z", syncedAt: "2026-11-20T11:30:00.000Z" });
    expect(ledger.runLinks(P, APP, [500, 501]).get(500)).toEqual({ workKey: issueKey(12), match: "titled" });
  });

  test("a run's trace follows its effects through work keys to workflow runs and PRs", () => {
    const ledger = createSqliteLedger({ path: ":memory:" });
    ledger.recordEffect(P, { runId: "run-sentry", automation: "sentry-to-github-issue", dryRun: false }, issueCreated(12));
    ledger.recordEffect(P, crispRun, dispatched(12, "2026-11-10T10:00:00.000Z", 501));
    ledger.recordEffect(P, crispRun, dispatched(12, "2026-11-10T10:00:00.000Z", 501));
    ledger.applyRepoSync(
      batch({
        pullRequests: [pullRequest(30, { state: "merged", mergedAt: "2026-11-11T10:00:00.000Z" }, { workKey: issueKey(12) })],
        workflowRuns: [workflowRun(500, 12), workflowRun(501, 12, "2026-11-10T10:00:03.000Z"), workflowRun(502, null)],
      }),
    );
    expect(ledger.dispatchedRuns(P, APP, [500, 501, 502])).toEqual(new Map([[501, issueKey(12)]]));

    const sentry = ledger.trace(P, "run-sentry", NOW);
    expect(sentry.workItems).toHaveLength(1);
    const item = sentry.workItems[0];
    expect(item?.key).toBe(issueKey(12));
    expect(item?.ref).toEqual({ kind: "github-issue", repo: APP, number: 12 });
    expect(item?.createdByThisRun).toBe(true);
    expect(item?.url).toBe("https://github.com/acme/app/issues/12");
    expect(item?.dispatches).toEqual([{ at: "2026-11-10T10:00:00.000Z", workflowFile: "codex-issue-fix.yml", ref: "main" }]);
    expect(item?.workflowRuns.map((r) => r.id)).toEqual([501, 500]);
    expect(item?.pullRequests.map((pr) => pr.number)).toEqual([30]);
    expect(item?.missingRun).toBe(false);
    expect(sentry.syncedAt).toBe("2026-11-20T11:30:00.000Z");

    expect(ledger.trace(P, "run-crisp", NOW).workItems[0]?.createdByThisRun).toBe(false);
    expect(ledger.trace(P, "unknown", NOW)).toEqual({ runId: "unknown", workItems: [], llm: { calls: [], totals: { calls: 0, promptTokens: 0, completionTokens: 0, cost: microUsd(0), unpriced: 0 } }, syncedAt: null });
  });

  test("a dispatch with no run seen 30 minutes later is flagged missing; a Linear dispatch keeps its issue URL", () => {
    const ledger = createSqliteLedger({ path: ":memory:" });
    const linear = workKey({ kind: "linear-issue", identifier: "ENG-42" });
    ledger.recordEffect(P, { runId: "run-linear", automation: "linear-label-to-pr", dryRun: false }, {
      kind: "workflow_dispatched",
      repo: APP,
      workKey: linear,
      url: "https://linear.app/acme/issue/ENG-42",
      workflowFile: "linear-implement.yml",
      ref: "main",
      workflowRunId: null,
      at: "2026-11-20T11:00:00.000Z",
    });
    const early = ledger.trace(P, "run-linear", new Date("2026-11-20T11:20:00.000Z")).workItems[0];
    expect(early?.missingRun).toBe(false);
    expect(early?.url).toBe("https://linear.app/acme/issue/ENG-42");
    expect(early?.ref).toEqual({ kind: "linear-issue", identifier: "ENG-42" });
    expect(ledger.trace(P, "run-linear", NOW).workItems[0]?.missingRun).toBe(true);
    expect(ledger.trace(P, "run-linear", NOW).syncedAt).toBeNull();
  });

  test("origin credits the first automation that touched the work item, else the producing workflow", () => {
    const ledger = createSqliteLedger({ path: ":memory:" });
    ledger.recordEffect(P, { runId: "run-sentry", automation: "sentry-to-github-issue", dryRun: false }, issueCreated(1, "2026-11-01T00:00:00.000Z"));
    ledger.recordEffect(P, { runId: "run-bot", automation: "slack-bot", dryRun: false }, dispatched(1, "2026-11-02T00:00:00.000Z"));
    ledger.recordEffect(P, crispRun, dispatched(2, "2026-11-03T00:00:00.000Z"));
    ledger.applyRepoSync(
      batch({
        pullRequests: [
          pullRequest(10, { state: "merged", mergedAt: "2026-11-12T10:00:00.000Z" }, { workKey: issueKey(1), createdAt: "2026-11-11T10:00:00.000Z" }),
          pullRequest(11, { state: "closed", closedAt: "2026-11-13T10:00:00.000Z" }, { workKey: issueKey(2), createdAt: "2026-11-12T10:00:00.000Z" }),
          pullRequest(12, { state: "open", draft: false }, { workKey: issueKey(3), createdAt: "2026-11-13T10:00:00.000Z" }),
          pullRequest(13, { state: "merged", mergedAt: "2026-11-15T10:00:00.000Z" }, { workKey: null, producer: "codex-seo-autopilot", createdAt: "2026-11-14T10:00:00.000Z" }),
        ],
      }),
    );

    const rows = ledger.pullRequests({ project: P, limit: 10 }).items;
    expect(rows.map((r) => [r.number, r.origin, r.originRunId])).toEqual([
      [13, { kind: "workflow", name: "codex-seo-autopilot" }, null],
      [12, { kind: "workflow", name: "codex-issue-fix" }, null],
      [11, { kind: "automation", name: "crisp-triage" }, "run-crisp"],
      [10, { kind: "automation", name: "sentry-to-github-issue" }, "run-sentry"],
    ]);

    const summary = ledger.outcomes(P, 30, NOW);
    expect(summary.overall).toEqual({ opened: 4, merged: 2, closed: 1, open: 1, usefulRate: 2 / 3, medianHoursToMerge: 24 });
    expect(summary.byOrigin.find((o) => o.origin.name === "sentry-to-github-issue")).toMatchObject({ merged: 1, usefulRate: 1 });
    expect(summary.byOrigin.find((o) => o.origin.name === "crisp-triage")).toMatchObject({ closed: 1, usefulRate: 0 });
    expect(summary.sync).toEqual([{ repo: APP, syncedAt: "2026-11-20T11:30:00.000Z", error: null }]);

    expect(ledger.pullRequests({ project: P, origin: "crisp-triage", limit: 10 }).items.map((r) => r.number)).toEqual([11]);
    expect(ledger.pullRequests({ project: P, origin: "codex-issue-fix", limit: 10 }).items.map((r) => r.number)).toEqual([12]);
    expect(ledger.pullRequests({ project: P, state: "merged", limit: 10 }).items.map((r) => r.number)).toEqual([13, 10]);
    const page1 = ledger.pullRequests({ project: P, limit: 3 });
    expect(page1.items.map((r) => r.number)).toEqual([13, 12, 11]);
    const page2 = ledger.pullRequests({ project: P, limit: 3, before: page1.nextCursor ?? undefined });
    expect(page2).toMatchObject({ nextCursor: null });
    expect(page2.items.map((r) => r.number)).toEqual([10]);
  });

  test("a sync error is kept per repository until the next good sync clears it", () => {
    const ledger = createSqliteLedger({ path: ":memory:" });
    ledger.recordSyncError(P, APP, "GitHub answered 404 for GET /repos/acme/app/pulls", NOW.toISOString());
    expect(ledger.outcomes(P, 30, NOW).sync).toEqual([{ repo: APP, syncedAt: null, error: "GitHub answered 404 for GET /repos/acme/app/pulls" }]);
    ledger.applyRepoSync(batch({}));
    expect(ledger.outcomes(P, 30, NOW).sync[0]?.error).toBeNull();
  });
});

describe("sqlite ledger: retention and persistence", () => {
  test("prune drops old facts and resolved PRs but keeps open ones", () => {
    const ledger = createSqliteLedger({ path: ":memory:" });
    ledger.recordLlmCall(P, crispRun, llmCall({ at: "2025-01-01T00:00:00.000Z" }));
    ledger.recordLlmCall(P, crispRun, llmCall({ at: "2026-11-01T00:00:00.000Z" }));
    ledger.recordEffect(P, crispRun, issueCreated(1, "2025-01-01T00:00:00.000Z"));
    ledger.applyRepoSync(
      batch({
        pullRequests: [
          pullRequest(1, { state: "open", draft: true }, { createdAt: "2025-01-01T00:00:00.000Z" }),
          pullRequest(2, { state: "merged", mergedAt: "2025-01-02T00:00:00.000Z" }, { createdAt: "2025-01-01T00:00:00.000Z" }),
        ],
        workflowRuns: [workflowRun(1, 1, "2025-01-01T00:00:00.000Z")],
      }),
    );
    expect(ledger.claimAlert(P, "2025-01", 80, NOW)).toBe(true);
    expect(ledger.prune("2026-01-01T00:00:00.000Z")).toBe(5);
    expect(ledger.pullRequests({ project: P, limit: 10 }).items.map((r) => r.number)).toEqual([1]);
    expect(ledger.costs(P, "2026-11", null, NOW).totals.calls).toBe(1);
    expect(() => ledger.prune("not a date")).toThrow();
  });

  test("data survives reopening the file, and migrating again is a no-op", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    try {
      const path = join(dir, "automation.db");
      const first = createSqliteLedger({ path });
      first.recordLlmCall(P, crispRun, llmCall({ generationId: "gen-1" }));
      first.close();
      const second = createSqliteLedger({ path });
      second.recordLlmCall(P, crispRun, llmCall({ generationId: "gen-1" }));
      expect(second.trace(P, "run-crisp", NOW).llm.totals.calls).toBe(1);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { errorMessage } from "@automation-server/api/errors";
import { currentRun, type Logger } from "@automation-server/core";
import { parseRepoName, workKey, workKeyFromDispatch, type GithubEffect, type LedgerRecorder, type Observer, type RecordScope, type StoredEffect } from "@automation-server/ledger";

import type { BudgetAlerter } from "./budget";

export type LedgerObserverDeps = {
  project: string;
  ledger: LedgerRecorder;
  budget: BudgetAlerter;
  log: Logger;
  now?: () => Date;
};

// Only a Linear issue link is kept from the dispatch inputs. Everything else in them is untrusted text.
function linearIssueUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "linear.app" && value.length <= 500 ? url.toString() : null;
  } catch {
    return null;
  }
}

function toStored(effect: GithubEffect, at: string): StoredEffect | null {
  const repo = parseRepoName(effect.repo);
  if (!repo) return null;
  if (effect.kind === "issue_created") return { kind: "issue_created", repo, workKey: workKey({ kind: "github-issue", repo, number: effect.number }), url: effect.url, at };
  return {
    kind: "workflow_dispatched",
    repo,
    workKey: workKeyFromDispatch(repo, effect.inputs),
    url: linearIssueUrl(effect.inputs.issue_url),
    workflowFile: effect.workflowFile,
    ref: effect.ref,
    workflowRunId: effect.workflowRunId,
    at,
  };
}

// One per project. Clients built at module build time report through it; the run comes from the ambient run scope.
// Recording is best effort: a failure is logged and never reaches the automation.
export function createLedgerObserver({ project, ledger, budget, log, now = () => new Date() }: LedgerObserverDeps): Observer {
  const scope = (): RecordScope | null => {
    const run = currentRun();
    return run ? { runId: run.runId, automation: run.automation, dryRun: run.dryRun } : null;
  };

  return {
    llm(call) {
      try {
        ledger.recordLlmCall(project, scope(), call);
      } catch (err) {
        log.error("ledger llm record failed", { project, error: errorMessage(err) });
        return;
      }
      void budget.check(project, now());
    },
    github(effect) {
      try {
        const stored = toStored(effect, now().toISOString());
        if (stored) ledger.recordEffect(project, scope(), stored);
        else log.warn("ledger effect skipped: repository name is not owner/name", { project, kind: effect.kind });
      } catch (err) {
        log.error("ledger effect record failed", { project, kind: effect.kind, error: errorMessage(err) });
      }
    },
  };
}

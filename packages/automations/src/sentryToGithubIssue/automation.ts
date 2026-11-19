import { defineAutomation } from "@automation-server/core/automation";
import type { Automation } from "@automation-server/core/automation";
import { isSentryIssueAlert } from "@automation-server/sources/sentry/event";

import { createGithubClient } from "../github";
import { shouldHandle } from "./config";
import type { SentryToGithubIssueConfig } from "./config";
import { formatIssue, sentryMarker } from "./format";

export const SENTRY_TO_GITHUB_ISSUE = "sentry-to-github-issue";

export function createSentryToGithubIssue(config: SentryToGithubIssueConfig): Automation {
  const github = createGithubClient(config);

  return defineAutomation({
    name: SENTRY_TO_GITHUB_ISSUE,
    matches: isSentryIssueAlert,
    async run(event, { log, dryRun }) {
      const alert = event.payload;
      const decision = shouldHandle(alert, config);
      if (!decision.handle) {
        log.info("skipped", { issueId: alert.issueId, reason: decision.reason });
        return;
      }

      const existing = await github.findOpenIssueByMarker("sentry", sentryMarker(alert.issueId));
      if (existing) {
        log.info("open github issue already exists", { issueId: alert.issueId, url: existing });
        return;
      }

      const issue = formatIssue(alert);
      if (dryRun) {
        log.info("dry-run: would create github issue", { issueId: alert.issueId, title: issue.title, labels: issue.labels });
        return;
      }
      await github.ensureLabels(issue.labels);
      const created = await github.createIssue(issue);
      log.info("created github issue", { issueId: alert.issueId, number: created.number, url: created.html_url });
    },
  });
}

import { defineAutomation } from "@automation-server/core/automation";
import type { Automation } from "@automation-server/core/automation";
import { isSentryIssueAlert } from "@automation-server/sources/sentry/event";

import { createGithubClient } from "../github";
import { shouldHandle } from "./config";
import type { SentryToGithubIssueConfig } from "./config";
import { formatIssue } from "./format";

export const SENTRY_TO_GITHUB_ISSUE = "sentry-to-github-issue";

export function createSentryToGithubIssue(config: SentryToGithubIssueConfig): Automation {
  const github = createGithubClient(config);

  return defineAutomation({
    name: SENTRY_TO_GITHUB_ISSUE,
    matches: isSentryIssueAlert,
    async run(event, { log }) {
      const alert = event.payload;
      const decision = shouldHandle(alert, config);
      if (!decision.handle) {
        log.info("skipped", { issueId: alert.issueId, reason: decision.reason });
        return;
      }

      const existing = await github.findOpenIssueBySentryId(alert.issueId);
      if (existing) {
        log.info("open github issue already exists", { issueId: alert.issueId, url: existing });
        return;
      }

      const issue = formatIssue(alert);
      await github.ensureLabels(issue.labels);
      const created = await github.createIssue(issue);
      log.info("created github issue", { issueId: alert.issueId, number: created.number, url: created.html_url });
    },
  });
}

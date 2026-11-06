import type { Automation } from "@automation-server/core/automation";

import { createSentryToGithubIssue } from "./sentryToGithubIssue/automation";
import type { SentryToGithubIssueConfig } from "./sentryToGithubIssue/config";

export type AutomationsConfig = { sentryToGithubIssue: SentryToGithubIssueConfig };

export function createAutomations(config: AutomationsConfig): Automation[] {
  return [
    createSentryToGithubIssue(config.sentryToGithubIssue),
  ];
}

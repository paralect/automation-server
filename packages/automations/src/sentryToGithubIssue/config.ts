import type { SentryIssueAlert } from "@automation-server/sources/sentry/types";

export type SentryToGithubIssueConfig = {
  repo: { owner: string; name: string };
  token: string;
  levels: string[];
  environments: string[];
  minEventCount: number;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
};

export type HandleDecision = { handle: boolean; reason?: string };

export function shouldHandle(alert: SentryIssueAlert, config: SentryToGithubIssueConfig): HandleDecision {
  const level = alert.level.toLowerCase();
  if (config.levels.length > 0 && !config.levels.some((l) => l.toLowerCase() === level)) {
    return { handle: false, reason: `level ${level} not in [${config.levels.join(", ")}]` };
  }

  if (config.environments.length > 0) {
    const env = alert.environment?.toLowerCase() ?? null;
    if (env === null || !config.environments.some((e) => e.toLowerCase() === env)) {
      return { handle: false, reason: `environment ${env ?? "unknown"} not in [${config.environments.join(", ")}]` };
    }
  }

  if (alert.issue && alert.issue.count < config.minEventCount) {
    return { handle: false, reason: `event count ${alert.issue.count} below minimum ${config.minEventCount}` };
  }

  return { handle: true };
}

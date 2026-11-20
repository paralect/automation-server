import type { LlmCall, PullRequestLifecycle, PullRequestRecord, RepoName, WorkKey } from "../src/types";
import { toMicroUsd } from "../src/facts";
import { parseRepoName, workKey } from "../src/workKey";

export function repo(value: string): RepoName {
  const parsed = parseRepoName(value);
  if (!parsed) throw new Error(`bad repo ${value}`);
  return parsed;
}

export const APP = repo("acme/app");
export const issueKey = (number: number, inRepo: RepoName = APP): WorkKey => workKey({ kind: "github-issue", repo: inRepo, number });

export const llmCall = (overrides: Partial<LlmCall> & { usd?: number | null } = {}): LlmCall => {
  const { usd = 0.01, ...rest } = overrides;
  return {
    provider: "openrouter",
    model: "anthropic/claude-haiku-5.5",
    purpose: "triage",
    generationId: null,
    promptTokens: 1000,
    completionTokens: 100,
    cost: usd === null ? null : toMicroUsd(usd),
    at: "2026-11-20T10:00:00.000Z",
    durationMs: 1200,
    ...rest,
  };
};

export const pullRequest = (number: number, lifecycle: PullRequestLifecycle, overrides: Partial<PullRequestRecord> = {}): PullRequestRecord => ({
  repo: APP,
  number,
  producer: "codex-issue-fix",
  workKey: issueKey(number),
  title: `Fix #${number}`,
  url: `https://github.com/acme/app/pull/${number}`,
  createdAt: "2026-11-10T10:00:00.000Z",
  lifecycle,
  ...overrides,
});

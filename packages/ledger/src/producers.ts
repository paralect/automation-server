import type { ProducerId } from "./types";

// Which PRs count as Codex PRs, and which workflow opened them. A PR on any other branch is never stored.
// test/producers.test.ts checks each entry against github-actions/, so a renamed branch fails the build instead of dropping PRs from the metrics.
export const PR_PRODUCERS = [
  { id: "codex-issue-fix", workflowFile: "codex-issue-fix.yml", branchPrefix: "codex/issue-" },
  { id: "linear-implement", workflowFile: "linear-implement.yml", branchPrefix: "linear/" },
  { id: "codex-seo-autopilot", workflowFile: "codex-seo-autopilot.yml", branchPrefix: "seo-autopilot/" },
  { id: "codex-changelog", workflowFile: "codex-changelog.yml", branchPrefix: "changelog/" },
] as const satisfies readonly { readonly id: ProducerId; readonly workflowFile: string; readonly branchPrefix: string }[];

export const PRODUCER_IDS: readonly ProducerId[] = PR_PRODUCERS.map((p) => p.id);

export const isProducerId = (value: string): value is ProducerId => PRODUCER_IDS.some((id) => id === value);

export function producerOfBranch(headBranch: string): ProducerId | null {
  return PR_PRODUCERS.find((p) => headBranch.startsWith(p.branchPrefix) && headBranch.length > p.branchPrefix.length)?.id ?? null;
}

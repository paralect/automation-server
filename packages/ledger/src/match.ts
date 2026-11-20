import type { RepoName, WorkflowRunMatch, WorkflowRunRecord, WorkKey } from "./types";
import { workKeyFromRunTitle } from "./workKey";

export type FetchedRun = Omit<WorkflowRunRecord, "link">;
export type RunLink = NonNullable<WorkflowRunRecord["link"]>;

// Evidence only, strongest first. There is no time-window guess: a wrong link is worse than none.
const RANK: Record<WorkflowRunMatch, number> = { exact: 3, titled: 2, linked: 1 };

export type LinkEvidence = {
  readonly repo: RepoName;
  // Run id -> work key of our dispatch that GitHub answered with that run id.
  readonly dispatched: ReadonlyMap<number, WorkKey>;
  // Run id -> work key of a Codex PR whose body says "Run log: <that run>".
  readonly linkedByPr: ReadonlyMap<number, WorkKey>;
  // What an earlier sync stored. A link is never downgraded, and an equal one never flips.
  readonly previous: ReadonlyMap<number, RunLink>;
};

export function linkRuns(runs: readonly FetchedRun[], evidence: LinkEvidence): WorkflowRunRecord[] {
  return runs.map((run) => {
    const candidates: (RunLink | null)[] = [
      evidence.previous.get(run.id) ?? null,
      linkOf(evidence.dispatched.get(run.id), "exact"),
      linkOf(workKeyFromRunTitle(evidence.repo, run.title), "titled"),
      linkOf(evidence.linkedByPr.get(run.id), "linked"),
    ];
    let best: RunLink | null = null;
    for (const candidate of candidates) {
      if (candidate && (!best || RANK[candidate.match] > RANK[best.match])) best = candidate;
    }
    return { ...run, link: best };
  });
}

const linkOf = (workKey: WorkKey | null | undefined, match: WorkflowRunMatch): RunLink | null => (workKey ? { workKey, match } : null);

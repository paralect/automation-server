import { describe, expect, test } from "bun:test";

import { linkRuns, type FetchedRun, type RunLink } from "../src/match";
import type { WorkKey } from "../src/types";
import { APP } from "./fixtures";
import { toWorkflowState } from "../src/workflowState";
import { workKey } from "../src/workKey";

const REPO = APP;
const issue = (number: number): WorkKey => workKey({ kind: "github-issue", repo: REPO, number });

const run = (id: number, title = "Fix issue with Codex"): FetchedRun => ({
  repo: REPO,
  id,
  producer: "codex-issue-fix",
  runNumber: id,
  title,
  state: "success",
  createdAt: "2026-11-20T10:00:00Z",
  url: `https://github.com/acme/app/actions/runs/${id}`,
});

const link = (records: ReturnType<typeof linkRuns>, id: number) => records.find((r) => r.id === id)?.link;
const none = new Map<number, WorkKey>();
const noPrevious = new Map<number, RunLink>();

describe("linking workflow runs to work items", () => {
  test("exact beats titled beats linked when evidence disagrees", () => {
    const records = linkRuns([run(1, "Codex issue fix #2"), run(2, "Codex issue fix #2"), run(3)], {
      repo: REPO,
      dispatched: new Map([[1, issue(1)]]),
      linkedByPr: new Map([
        [1, issue(3)],
        [2, issue(3)],
        [3, issue(3)],
      ]),
      previous: noPrevious,
    });
    expect(link(records, 1)).toEqual({ workKey: issue(1), match: "exact" });
    expect(link(records, 2)).toEqual({ workKey: issue(2), match: "titled" });
    expect(link(records, 3)).toEqual({ workKey: issue(3), match: "linked" });
  });

  test("a run with no evidence stays unlinked: there is no guessing by time", () => {
    const records = linkRuns([run(9)], { repo: REPO, dispatched: none, linkedByPr: none, previous: noPrevious });
    expect(link(records, 9)).toBeNull();
  });

  test("a stored link is never downgraded by weaker evidence on a later sync, but is upgraded by stronger", () => {
    const previous = new Map<number, RunLink>([
      [1, { workKey: issue(1), match: "exact" }],
      [2, { workKey: issue(2), match: "linked" }],
      [3, { workKey: issue(3), match: "titled" }],
    ]);
    const records = linkRuns([run(1, "Codex issue fix #5"), run(2, "Codex issue fix #2"), run(3)], {
      repo: REPO,
      dispatched: none,
      linkedByPr: new Map([[3, issue(4)]]),
      previous,
    });
    expect(link(records, 1)).toEqual({ workKey: issue(1), match: "exact" });
    expect(link(records, 2)).toEqual({ workKey: issue(2), match: "titled" });
    expect(link(records, 3)).toEqual({ workKey: issue(3), match: "titled" });
  });
});

describe("workflow state", () => {
  test.each([
    ["queued", null, "queued"],
    ["in_progress", null, "running"],
    ["waiting", null, "waiting"],
    ["pending", null, "queued"],
    ["completed", "success", "success"],
    ["completed", "neutral", "success"],
    ["completed", "failure", "failure"],
    ["completed", "timed_out", "failure"],
    ["completed", "startup_failure", "failure"],
    ["completed", "cancelled", "cancelled"],
    ["completed", "skipped", "skipped"],
    ["completed", "stale", "skipped"],
    ["completed", "action_required", "waiting"],
  ] as const)("%s / %s -> %s", (status, conclusion, state) => {
    expect(toWorkflowState(status, conclusion)).toBe(state);
  });
});

import { createGithubActionsReader, toState } from "@automation-server/api/githubActions";
import { describe, expect, test } from "bun:test";

const run = (id: number, createdAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: "Codex issue fix",
  display_title: `Issue ${id}`,
  run_number: id,
  run_attempt: 1,
  event: "issues",
  status: "completed",
  conclusion: "success",
  head_branch: "main",
  head_sha: "abc1234def",
  html_url: `https://github.com/x/runs/${id}`,
  created_at: createdAt,
  updated_at: createdAt,
  run_started_at: createdAt,
  actor: { login: "octocat", avatar_url: "https://avatars/octocat" },
  ...extra,
});

function fakeGithub(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const key = `${url.pathname}${url.search}`;
    calls.push(key);
    const hit = Object.entries(routes).find(([prefix]) => key.startsWith(prefix));
    return hit ? hit[1]() : new Response("{}", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("toState", () => {
  test.each([
    ["queued", null, "queued"],
    ["requested", null, "queued"],
    ["waiting", null, "waiting"],
    ["in_progress", null, "running"],
    ["completed", "success", "success"],
    ["completed", "timed_out", "failure"],
    ["completed", "startup_failure", "failure"],
    ["completed", "cancelled", "cancelled"],
    ["completed", "skipped", "skipped"],
    ["completed", "action_required", "waiting"],
  ] as const)("%s/%s is %s", (status, conclusion, state) => {
    expect(toState(status, conclusion)).toBe(state);
  });
});

describe("GitHub Actions reader", () => {
  test("merges repos newest first and reports a failing repo without failing the list", async () => {
    const gh = fakeGithub({
      "/repos/a/one/actions/workflows": () => Response.json({ workflows: [{ id: 7, name: "Codex issue fix" }] }),
      "/repos/a/one/actions/runs": () => Response.json({ workflow_runs: [run(1, "2026-11-10T10:00:00Z")] }),
      "/repos/a/two/actions/workflows": () => Response.json({ workflows: [{ id: 8, name: "Changelog" }] }),
      "/repos/a/two/actions/runs": () =>
        Response.json({ workflow_runs: [run(2, "2026-11-10T11:00:00Z", { status: "in_progress", conclusion: null })] }),
      "/repos/a/three/": () => new Response("{}", { status: 403 }),
    });
    const reader = createGithubActionsReader({ repos: ["a/one", "a/two", "a/three"], token: "t", fetch: gh.fetch });

    const list = await reader.listRuns({ page: 1 });

    expect(list.runs.map((r) => [r.repo, r.id, r.state])).toEqual([
      ["a/two", 2, "running"],
      ["a/one", 1, "success"],
    ]);
    expect(list.workflows).toEqual(["Changelog", "Codex issue fix"]);
    expect(list.errors).toEqual([{ repo: "a/three", message: "The token lacks Actions: Read on this repository" }]);
    expect(list.nextPage).toBeNull();
  });

  test("a workflow filter queries that workflow's runs and skips repos without it", async () => {
    const gh = fakeGithub({
      "/repos/a/one/actions/workflows?": () => Response.json({ workflows: [{ id: 7, name: "Codex issue fix" }] }),
      "/repos/a/one/actions/workflows/7/runs": () => Response.json({ workflow_runs: [run(1, "2026-11-10T10:00:00Z")] }),
      "/repos/a/two/actions/workflows?": () => Response.json({ workflows: [] }),
    });
    const reader = createGithubActionsReader({ repos: ["a/one", "a/two"], token: "t", fetch: gh.fetch });

    const list = await reader.listRuns({ page: 1, workflow: "Codex issue fix", state: "running" });

    expect(list.runs.map((r) => r.id)).toEqual([1]);
    expect(gh.calls).toContain("/repos/a/one/actions/workflows/7/runs?per_page=25&page=1&status=in_progress");
    expect(gh.calls.some((c) => c.startsWith("/repos/a/two/actions/runs"))).toBe(false);
  });

  test("repeated polls inside the cache window hit GitHub once", async () => {
    let clock = 0;
    const gh = fakeGithub({
      "/repos/a/one/actions/workflows": () => Response.json({ workflows: [] }),
      "/repos/a/one/actions/runs": () => Response.json({ workflow_runs: [] }),
    });
    const reader = createGithubActionsReader({ repos: ["a/one"], token: "t", fetch: gh.fetch, now: () => clock });
    const runCalls = () => gh.calls.filter((c) => c.startsWith("/repos/a/one/actions/runs")).length;

    await Promise.all([reader.listRuns({ page: 1 }), reader.listRuns({ page: 1 })]);
    expect(runCalls()).toBe(1);
    clock = 5_000;
    await reader.listRuns({ page: 1 });
    expect(runCalls()).toBe(2);
  });

  test("getRun maps jobs and steps, and ignores repos outside the allowlist", async () => {
    const gh = fakeGithub({
      "/repos/a/one/actions/runs/5/jobs": () =>
        Response.json({
          jobs: [
            {
              id: 50,
              name: "Fix issue with Codex",
              status: "completed",
              conclusion: "failure",
              started_at: "2026-11-10T10:00:00Z",
              completed_at: "2026-11-10T10:04:00Z",
              html_url: "https://github.com/x/job/50",
              runner_name: "GitHub Actions 2",
              steps: [
                { number: 1, name: "Set up job", status: "completed", conclusion: "success" },
                { number: 2, name: "Run Codex", status: "completed", conclusion: "failure" },
              ],
            },
          ],
        }),
      "/repos/a/one/actions/runs/5": () => Response.json(run(5, "2026-11-10T10:00:00Z", { conclusion: "failure" })),
    });
    const reader = createGithubActionsReader({ repos: ["a/one"], token: "t", fetch: gh.fetch });

    const found = await reader.getRun("a/one", 5);
    expect(found?.run.state).toBe("failure");
    expect(found?.jobs[0]?.steps.map((s) => s.state)).toEqual(["success", "failure"]);
    expect(await reader.getRun("a/other", 5)).toBeNull();
    expect(await reader.getRun("a/one", 6)).toBeNull();
    expect(gh.calls.some((c) => c.startsWith("/repos/a/other"))).toBe(false);
  });
});

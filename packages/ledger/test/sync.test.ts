import { describe, expect, test } from "bun:test";

import type { Logger } from "@automation-server/core";

import { createSqliteLedger } from "../src/sqliteLedger";
import { createOutcomeSyncJob, outcomeSyncKey } from "../src/sync";
import type { RepoName } from "../src/types";
import { workKey } from "../src/workKey";
import { APP, issueKey, repo } from "./fixtures";

const quiet: Logger = { info() {}, warn() {}, error() {} };
const NOW = new Date("2026-11-20T12:00:00.000Z");
const TOKEN = "ghp_secretsecretsecretsecret";

const pull = (number: number, head: string, extra: Record<string, unknown> = {}) => ({
  number,
  title: `PR ${number}`,
  html_url: `https://github.com/acme/app/pull/${number}`,
  state: "open",
  draft: true,
  body: null,
  created_at: "2026-11-19T10:00:00Z",
  updated_at: "2026-11-19T11:00:00Z",
  closed_at: null,
  merged_at: null,
  head: { ref: head },
  ...extra,
});

const runJson = (id: number, title: string) => ({
  id,
  run_number: id,
  display_title: title,
  status: "completed",
  conclusion: "success",
  created_at: "2026-11-19T09:00:00Z",
  html_url: `https://github.com/acme/app/actions/runs/${id}`,
});

type Route = (url: URL) => Response | undefined;

function fakeGithub(routes: Record<string, Route>) {
  const calls: { url: string; auth: string | null }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), auth: new Headers(init?.headers).get("authorization") });
    const route = routes[url.pathname];
    return route?.(url) ?? new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}

const setup = (routes: Record<string, Route>, repos: readonly RepoName[] = [APP]) => {
  const ledger = createSqliteLedger({ path: ":memory:" });
  const github = fakeGithub(routes);
  const job = createOutcomeSyncJob({ project: "default", ledger, token: TOKEN, repos: () => repos, fetch: github.fn });
  const run = () => job.run({ log: quiet, key: outcomeSyncKey(NOW), now: NOW });
  return { ledger, github, job, run };
};

describe("outcome sync job", () => {
  test("is due once per hour by its claim key", () => {
    const { job } = setup({});
    expect(job.due(NOW)).toBe("2026-11-20T12");
    expect(job.due(new Date("2026-11-20T12:59:00Z"))).toBe("2026-11-20T12");
    expect(job.due(new Date("2026-11-20T13:00:00Z"))).toBe("2026-11-20T13");
  });

  test("stores only Codex PRs, links runs by title and by the PR's Run log line, and skips workflows that are not installed", async () => {
    const { ledger, github, run } = setup({
      "/repos/acme/app/pulls": () =>
        Response.json([
          pull(30, "codex/issue-12", { body: "Fix\n\nRefs #12\nRun log: https://github.com/acme/app/actions/runs/701" }),
          pull(31, "linear/eng-42", { title: "ENG-42: Export", state: "closed", draft: false, merged_at: "2026-11-19T12:00:00Z", closed_at: "2026-11-19T12:00:00Z" }),
          pull(32, "feature/by-hand"),
        ]),
      "/repos/acme/app/actions/workflows/codex-issue-fix.yml/runs": () => Response.json({ workflow_runs: [runJson(700, "Codex issue fix #12"), runJson(701, "Fix issue with Codex")] }),
      "/repos/acme/app/actions/workflows/linear-implement.yml/runs": () => Response.json({ workflow_runs: [runJson(800, "Linear implement ENG-42")] }),
    });
    await run();

    const prs = ledger.pullRequests({ project: "default", limit: 10 }).items;
    expect<unknown>(prs.map((p) => [p.number, p.producer, p.workKey, p.lifecycle.state])).toEqual([
      [31, "linear-implement", "linear:ENG-42", "merged"],
      [30, "codex-issue-fix", issueKey(12), "open"],
    ]);
    expect(ledger.runLinks("default", APP, [700, 701, 800])).toEqual(
      new Map([
        [700, { workKey: issueKey(12), match: "titled" }],
        [701, { workKey: issueKey(12), match: "linked" }],
        [800, { workKey: workKey({ kind: "linear-issue", identifier: "ENG-42" }), match: "titled" }],
      ]),
    );
    expect(ledger.syncState("default", APP)).toEqual({ prCursor: "2026-11-19T11:00:00Z", syncedAt: NOW.toISOString() });
    expect(github.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(github.calls.find((c) => c.url.includes("/pulls"))?.url).toContain("state=all&sort=updated&direction=desc");
    expect(github.calls.find((c) => c.url.includes("codex-issue-fix.yml"))?.url).toContain("created=%3E%3D2026-08-22");
  });

  test("a second sync re-reads only from the cursor and two days of runs, and changes nothing when GitHub has nothing new", async () => {
    const { ledger, github, run } = setup({
      "/repos/acme/app/pulls": () => Response.json([pull(30, "codex/issue-12")]),
      "/repos/acme/app/actions/workflows/codex-issue-fix.yml/runs": () => Response.json({ workflow_runs: [runJson(700, "Codex issue fix #12")] }),
    });
    await run();
    const before = ledger.pullRequests({ project: "default", limit: 10 });
    github.calls.length = 0;
    await run();
    expect(ledger.pullRequests({ project: "default", limit: 10 })).toEqual(before);
    expect(github.calls.find((c) => c.url.includes("codex-issue-fix.yml"))?.url).toContain("created=%3E%3D2026-11-18");
  });

  test("one repository failing is recorded on that repository while the others sync; all failing fails the run", async () => {
    const other = repo("acme/other");
    const { ledger, run } = setup(
      {
        "/repos/acme/app/pulls": () => Response.json([pull(30, "codex/issue-12")]),
        "/repos/acme/other/pulls": () => new Response("{}", { status: 403 }),
      },
      [APP, other],
    );
    await run();
    const sync = ledger.outcomes("default", 30, NOW).sync;
    expect(sync).toEqual([
      { repo: APP, syncedAt: NOW.toISOString(), error: null },
      { repo: other, syncedAt: null, error: "GitHub answered 403 for GET /repos/acme/other/pulls" },
    ]);

    const broken = setup({ "/repos/acme/app/pulls": () => new Response("{}", { status: 401 }) });
    await expect(broken.run()).rejects.toThrow("outcome sync failed for every repository");
    expect(JSON.stringify(broken.ledger.outcomes("default", 30, NOW).sync)).not.toContain(TOKEN);
  });
});

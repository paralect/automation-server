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
  const run = (now = NOW) => job.run({ log: quiet, key: outcomeSyncKey(now), now });
  return { ledger, github, job, run };
};

// GitHub's paging: newest first, `page` and `per_page`.
const paged = <T>(items: readonly T[], url: URL) => {
  const perPage = Number(url.searchParams.get("per_page") ?? 30);
  const page = Number(url.searchParams.get("page") ?? 1);
  return items.slice((page - 1) * perPage, page * perPage);
};

// GET /pulls?sort=updated&direction=desc over a mutable list of PRs.
const pullsRoute = (pulls: ReturnType<typeof pull>[]): Route => (url) =>
  Response.json(paged([...pulls].sort((a, b) => b.updated_at.localeCompare(a.updated_at)), url));

// GET /actions/workflows/<file>/runs honouring `created=>=<date>` and `created=<date>..<date-time>`.
const runsRoute = (runs: ReturnType<typeof runJson>[]): Route => (url) => {
  const created = url.searchParams.get("created") ?? "";
  const [from = "", to] = created.startsWith(">=") ? [created.slice(2)] : created.split("..");
  const inRange = runs.filter((r) => r.created_at >= from && (to === undefined || r.created_at <= to));
  return Response.json({ workflow_runs: paged([...inRange].sort((a, b) => b.created_at.localeCompare(a.created_at)), url) });
};

const hoursBefore = (at: Date, hours: number) => new Date(at.getTime() - hours * 3_600_000).toISOString().replace(".000Z", "Z");

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
    expect(ledger.syncState("default", APP)).toEqual({ prCursor: "2026-11-19T11:00:00Z", prResume: null, runCursor: NOW.toISOString(), runResume: null });
    expect(ledger.outcomes("default", 30, NOW).sync).toEqual([{ repo: APP, syncedAt: NOW.toISOString(), error: null }]);
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

  test("a changelog PR that quotes an issue reference is credited to its workflow, not to the automation behind that issue", async () => {
    const { ledger, run } = setup({
      "/repos/acme/app/pulls": () => Response.json([pull(40, "changelog/abc1234", { title: "Changelog for production @ abc1234", body: "- Fix checkout, closes #42\n- Refs #43" })]),
    });
    ledger.recordEffect("default", { runId: "run-sentry", automation: "sentry-to-github-issue", dryRun: false }, {
      kind: "issue_created",
      repo: APP,
      workKey: issueKey(42),
      url: "https://github.com/acme/app/issues/42",
      at: "2026-11-18T09:00:00.000Z",
    });
    await run();
    const [pr] = ledger.pullRequests({ project: "default", limit: 10 }).items;
    expect(pr?.workKey).toBeNull();
    expect(pr?.origin).toEqual({ kind: "workflow", name: "codex-changelog" });
    expect(ledger.trace("default", "run-sentry", NOW).workItems[0]?.pullRequests).toEqual([]);
  });

  test("runs created while syncs were failing are read once a sync succeeds again", async () => {
    const lastGood = new Date("2026-11-10T12:00:00.000Z");
    const runs = [runJson(700, "Codex issue fix #12")].map((r) => ({ ...r, created_at: "2026-11-09T09:00:00Z" }));
    const { ledger, run } = setup({
      "/repos/acme/app/pulls": pullsRoute([pull(30, "codex/issue-12", { updated_at: "2026-11-09T11:00:00Z" })]),
      "/repos/acme/app/actions/workflows/codex-issue-fix.yml/runs": runsRoute(runs),
    });
    await run(lastGood);
    runs.push({ ...runJson(701, "Codex issue fix #13"), created_at: "2026-11-12T09:00:00Z" });
    await run(NOW);
    expect(ledger.runLinks("default", APP, [700, 701])).toEqual(
      new Map([
        [700, { workKey: issueKey(12), match: "titled" }],
        [701, { workKey: issueKey(13), match: "titled" }],
      ]),
    );
  });

  test("a PR read stopped by the page cap continues where it stopped on the next sync and then follows new updates", async () => {
    const pulls = Array.from({ length: 1150 }, (_, i) => pull(i + 1, `codex/issue-${i + 1}`, { updated_at: hoursBefore(NOW, i + 1) }));
    const { ledger, run } = setup({ "/repos/acme/app/pulls": pullsRoute(pulls) });
    const stored = () => ledger.pullRequests({ project: "default", limit: 5000 }).items.length;

    await run();
    expect(stored()).toBe(1000);
    pulls.push(pull(2000, "codex/issue-2000", { updated_at: hoursBefore(NOW, 0.5) }));
    await run(new Date(NOW.getTime() + 3_600_000));
    expect(stored()).toBe(1150);
    await run(new Date(NOW.getTime() + 7_200_000));
    expect(stored()).toBe(1151);
  });

  test("a workflow run read stopped by the page cap continues where it stopped on the next sync", async () => {
    const runs = Array.from({ length: 350 }, (_, i) => ({ ...runJson(1000 + i, `Codex issue fix #${i + 1}`), created_at: hoursBefore(NOW, i + 1) }));
    const { ledger, run } = setup({
      "/repos/acme/app/pulls": () => Response.json([]),
      "/repos/acme/app/actions/workflows/codex-issue-fix.yml/runs": runsRoute(runs),
    });
    const ids = runs.map((r) => r.id);
    await run();
    expect(ledger.runLinks("default", APP, ids).size).toBe(300);
    await run(new Date(NOW.getTime() + 3_600_000));
    expect(ledger.runLinks("default", APP, ids).size).toBe(350);
  });

  test("workflow runs the token cannot read do not hold back the PRs, and show as the repository's sync error", async () => {
    const forbidden = { status: 403 };
    const { ledger, run } = setup({
      "/repos/acme/app/pulls": () => Response.json([pull(30, "codex/issue-12")]),
      "/repos/acme/app/actions/workflows/codex-issue-fix.yml/runs": () =>
        forbidden.status === 403 ? new Response("{}", { status: 403 }) : Response.json({ workflow_runs: [runJson(700, "Codex issue fix #12")] }),
    });
    await run();
    expect(ledger.pullRequests({ project: "default", limit: 10 }).items.map((p) => p.number)).toEqual([30]);
    expect(ledger.outcomes("default", 30, NOW).sync).toEqual([
      { repo: APP, syncedAt: NOW.toISOString(), error: "Workflow runs not read: GitHub answered 403 for GET /repos/acme/app/actions/workflows/codex-issue-fix.yml/runs" },
    ]);

    forbidden.status = 200;
    await run(new Date(NOW.getTime() + 3_600_000));
    expect(ledger.outcomes("default", 30, NOW).sync[0]?.error).toBeNull();
    expect(ledger.runLinks("default", APP, [700]).size).toBe(1);
  });

  test("a GitHub request slower than the timeout is abandoned and recorded as the repository's error", async () => {
    const ledger = createSqliteLedger({ path: ":memory:" });
    const slow = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response("{}", { status: 404 })), 500);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal?.reason);
        });
      })) as typeof fetch;
    const job = createOutcomeSyncJob({ project: "default", ledger, token: TOKEN, repos: () => [APP], fetch: slow, timeoutMs: 20 });
    await expect(job.run({ log: quiet, key: outcomeSyncKey(NOW), now: NOW })).rejects.toThrow("outcome sync failed for every repository");
    expect(ledger.outcomes("default", 30, NOW).sync[0]?.error).toBe("GitHub GET /repos/acme/app/pulls failed: timed out");
  });
});

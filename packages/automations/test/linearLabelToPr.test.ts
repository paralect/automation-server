import { describe, expect, test } from "bun:test";

import type { Logger } from "@automation-server/core/logger";
import type { LinearIssue, LinearIssueEvent } from "@automation-server/sources/linear/event";

import { createLinearLabelToPr, MAX_INPUT_CHARS, workflowInputs, type LinearLabelToPrConfig } from "../src/linearLabelToPr/automation";
import { json, mockFetch } from "./github.test";

const TOKEN = "ghp_SUPERSECRETTOKEN";

const issue = (over: Partial<LinearIssue> = {}): LinearIssue => ({
  action: "update",
  issueId: "issue-1",
  identifier: "ENG-42",
  title: "Fix login redirect",
  description: "Users land on a 404 after login.",
  url: "https://linear.app/acme/issue/ENG-42/fix-login",
  teamKey: "ENG",
  state: "Todo",
  labels: [
    { id: "l-bug", name: "Bug" },
    { id: "l-codex", name: "Codex" },
  ],
  addedLabelIds: ["l-codex"],
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const event = (payload: LinearIssue): LinearIssueEvent => ({
  source: "linear",
  kind: "issue",
  externalId: `${payload.issueId}:${payload.addedLabelIds.join("+")}@${payload.updatedAt}`,
  receivedAt: "2026-01-01T00:00:00.000Z",
  payload,
});

const lines: string[] = [];
const log: Logger = {
  info: (m, f) => lines.push(`${m} ${JSON.stringify(f ?? {})}`),
  warn: (m, f) => lines.push(`${m} ${JSON.stringify(f ?? {})}`),
  error: (m, f) => lines.push(`${m} ${JSON.stringify(f ?? {})}`),
};

const make = (f: typeof fetch, over: Partial<LinearLabelToPrConfig> = {}) =>
  createLinearLabelToPr({
    triggerLabel: "codex",
    repo: { owner: "o", name: "r" },
    token: TOKEN,
    workflowFile: "linear-implement.yml",
    ref: "",
    fetch: f,
    ...over,
  });

describe("linear-label-to-pr", () => {
  const noFetch = mockFetch(() => json(500, {})).fn;

  test("matches only when the trigger label was newly added, case-insensitive", () => {
    const automation = make(noFetch, { triggerLabel: " CODEX " });
    expect(automation.matches(event(issue()))).toBe(true);
    expect(automation.matches(event(issue({ addedLabelIds: ["l-bug"] })))).toBe(false);
    expect(make(noFetch, { triggerLabel: "ship" }).matches(event(issue()))).toBe(false);
    expect(automation.matches({ ...event(issue()), source: "sentry" })).toBe(false);
  });

  test("dispatches the workflow on the default branch with the issue as inputs", async () => {
    const { fn, calls } = mockFetch((c) => (c.method === "GET" ? json(200, { default_branch: "main" }) : new Response(null, { status: 204 })));
    await make(fn).run(event(issue()), { log });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.github.com/repos/o/r",
      "POST https://api.github.com/repos/o/r/actions/workflows/linear-implement.yml/dispatches",
    ]);
    expect(calls[1]?.body).toEqual({
      ref: "main",
      inputs: {
        issue_identifier: "ENG-42",
        issue_title: "Fix login redirect",
        issue_url: "https://linear.app/acme/issue/ENG-42/fix-login",
        issue_description: "Users land on a 404 after login.",
      },
    });
  });

  test("a dry run reads the default branch, dispatches nothing and says what it would do", async () => {
    const { fn, calls } = mockFetch((c) => (c.method === "GET" ? json(200, { default_branch: "main" }) : new Response(null, { status: 204 })));
    lines.length = 0;
    await make(fn).run(event(issue()), { log, dryRun: true });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(lines).toEqual([expect.stringContaining("dry-run: would dispatch workflow")]);
    expect(lines[0]).toContain('"ref":"main"');
  });

  test("a configured ref skips the default branch lookup", async () => {
    const { fn, calls } = mockFetch(() => new Response(null, { status: 204 }));
    await make(fn, { ref: "develop" }).run(event(issue()), { log });
    expect(calls).toHaveLength(1);
    expect((calls[0]?.body as { ref: string }).ref).toBe("develop");
  });

  test("404 points at the admin Workflows page and never leaks the token", async () => {
    const { fn } = mockFetch((c) => (c.method === "GET" ? json(200, { default_branch: "main" }) : json(404, { message: `Not Found ${TOKEN}` })));
    const err = (await make(fn).run(event(issue()), { log }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("Workflow linear-implement.yml was not found in o/r");
    expect(err.message).toContain("admin Workflows page");
    expect(err.message).not.toContain(TOKEN);
  });

  test("422 explains the missing workflow_dispatch trigger or ref", async () => {
    const { fn } = mockFetch(() => json(422, { message: "Workflow does not have 'workflow_dispatch' trigger" }));
    const err = (await make(fn, { ref: "main" }).run(event(issue()), { log }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("no workflow_dispatch trigger");
    expect(err.message).toContain("admin Workflows page");
  });

  test("a long description is truncated to fit the inputs limit and logged without its text", async () => {
    const long = "x".repeat(MAX_INPUT_CHARS + 500);
    const { inputs, truncatedFrom } = workflowInputs(issue({ description: long }));
    expect(truncatedFrom).toBe(long.length);
    expect(Object.values(inputs).reduce((n, v) => n + v.length, 0)).toBeLessThanOrEqual(MAX_INPUT_CHARS);
    expect(inputs.issue_description).toContain("Description truncated");

    lines.length = 0;
    const { fn } = mockFetch(() => new Response(null, { status: 204 }));
    await make(fn, { ref: "main" }).run(event(issue({ description: long })), { log });
    expect(lines.some((l) => l.startsWith("issue description truncated"))).toBe(true);
    expect(lines.join("\n")).not.toContain("xxxxxxxx");
  });

  test("a short description is passed through untouched", () => {
    expect(workflowInputs(issue()).truncatedFrom).toBeNull();
  });
});

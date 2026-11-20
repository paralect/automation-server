import { describe, expect, test } from "bun:test";

import type { RepoName } from "../src/types";
import { parseRepoName, parseWorkKey, workflowRunIdFromBody, workKey, workKeyFromDispatch, workKeyFromPullRequest, workKeyFromRunTitle } from "../src/workKey";

const repo = (value: string): RepoName => {
  const parsed = parseRepoName(value);
  if (!parsed) throw new Error(`bad repo ${value}`);
  return parsed;
};
const APP = repo("Acme/App");

describe("work keys", () => {
  test("canonical form: repositories lowercase, Linear identifiers uppercase", () => {
    expect<unknown>(APP).toBe("acme/app");
    expect<unknown>(workKey({ kind: "github-issue", repo: APP, number: 123 })).toBe("gh:acme/app#123");
    expect<unknown>(workKey({ kind: "linear-issue", identifier: "eng-42" })).toBe("linear:ENG-42");
    expect<unknown>(parseWorkKey("gh:acme/app#123")).toEqual({ kind: "github-issue", repo: APP, number: 123 });
    expect<unknown>(parseWorkKey("linear:ENG-42")).toEqual({ kind: "linear-issue", identifier: "ENG-42" });
    for (const bad of ["gh:acme#1", "gh:Acme/App#1", "gh:acme/app#0", "linear:eng-42", "linear:42", "jira:X-1", ""]) expect<unknown>(parseWorkKey(bad)).toBeNull();
    expect<unknown>(parseRepoName("not a repo")).toBeNull();
  });

  test("dispatch inputs reduce to the work item they name", () => {
    expect<unknown>(workKeyFromDispatch(APP, { issue_number: "123" })).toBe("gh:acme/app#123");
    expect<unknown>(workKeyFromDispatch(APP, { issue_identifier: "ENG-42", issue_title: "Fix login", issue_url: "https://linear.app/acme/issue/ENG-42", issue_description: "long text" })).toBe(
      "linear:ENG-42",
    );
    expect<unknown>(workKeyFromDispatch(APP, { issue: "12" })).toBeNull();
    expect<unknown>(workKeyFromDispatch(APP, { issue_number: "12; rm -rf /" })).toBeNull();
    expect<unknown>(workKeyFromDispatch(APP, {})).toBeNull();
  });

  test("a codex-issue-fix PR is keyed by its branch", () => {
    const pr = { repo: APP, headBranch: "codex/issue-123", title: "Checkout crashes on empty cart", body: "Codex summary\n\nRefs #999\n" };
    expect<unknown>(workKeyFromPullRequest(pr)).toBe("gh:acme/app#123");
  });

  test("a linear-implement PR is keyed by the identifier in its title when the branch slug agrees", () => {
    expect<unknown>(workKeyFromPullRequest({ repo: APP, headBranch: "linear/eng-42", title: "ENG-42: Add CSV export", body: "Linear: https://linear.app/acme/issue/ENG-42\nRun log: x" })).toBe(
      "linear:ENG-42",
    );
    expect<unknown>(workKeyFromPullRequest({ repo: APP, headBranch: "linear/eng-42", title: "Renamed by a person", body: "" })).toBe("linear:ENG-42");
    expect<unknown>(workKeyFromPullRequest({ repo: APP, headBranch: "linear/eng-42", title: "OPS-7: wrong title", body: "" })).toBe("linear:ENG-42");
  });

  test("a PR on another branch is keyed by an issue reference in its body, else not at all", () => {
    expect<unknown>(workKeyFromPullRequest({ repo: APP, headBranch: "changelog/abc1234", title: "Changelog for production @ abc1234", body: "Fixes #77 by hand" })).toBe("gh:acme/app#77");
    expect<unknown>(workKeyFromPullRequest({ repo: APP, headBranch: "seo-autopilot/2026-11-20-123", title: "SEO autopilot 2026-11-20", body: "Run log: https://github.com/acme/app/actions/runs/1" })).toBeNull();
  });

  test("run titles from the templates' run-name carry the key; older installs carry none", () => {
    expect<unknown>(workKeyFromRunTitle(APP, "Codex issue fix #123")).toBe("gh:acme/app#123");
    expect<unknown>(workKeyFromRunTitle(APP, "Linear implement ENG-42")).toBe("linear:ENG-42");
    expect<unknown>(workKeyFromRunTitle(APP, "Codex issue fix")).toBeNull();
    expect<unknown>(workKeyFromRunTitle(APP, "Checkout crashes on empty cart")).toBeNull();
  });

  test("the Run log line in a PR body names the run, only in the same repository", () => {
    const body = "Summary\n\nLinear: https://linear.app/acme/issue/ENG-42\nRun log: https://github.com/Acme/App/actions/runs/987654321\n";
    expect<unknown>(workflowRunIdFromBody(APP, body)).toBe(987654321);
    expect<unknown>(workflowRunIdFromBody(repo("acme/other"), body)).toBeNull();
    expect<unknown>(workflowRunIdFromBody(APP, "Refs #12")).toBeNull();
    expect<unknown>(workflowRunIdFromBody(APP, "Run log: https://ghe.example.com/acme/app/actions/runs/5")).toBe(5);
  });
});

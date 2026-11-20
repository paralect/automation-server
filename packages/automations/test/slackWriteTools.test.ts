import { describe, expect, test } from "bun:test";
import { UNOBSERVED } from "@automation-server/ledger";
import { z } from "zod";

import { buildReadTools, buildWriteTools, executeTool, type AnyTool, type ToolContext } from "../src/slackBot/tools";

const ctx: ToolContext = { requestedBy: "U1", channel: "C1", threadTs: "1.1", dryRun: false };
const LINEAR_KEY = "lin_api_secretsecretsecret";
const GH_TOKEN = "ghp_secretTokenValue1234567890";

const named = (tools: readonly AnyTool[], name: string) => tools.find((t) => t.name === name)!;
const summary = { identifier: "ENG-7", title: "Billing bug", url: "https://linear.app/acme/issue/ENG-7", state: { name: "Todo" }, assignee: null };

type GraphqlCall = { query: string; variables: Record<string, any> };

const linearFake = (labels: { id: string; name: string; team: { key: string } | null }[] = [{ id: "L1", name: "Bug", team: null }], teams = [{ id: "T1", key: "ENG" }]) => {
  const calls: GraphqlCall[] = [];
  const fn = (async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body)) as GraphqlCall;
    calls.push({ query, variables });
    if (query.includes("teams(")) return Response.json({ data: { teams: { nodes: teams } } });
    if (query.includes("issueLabels")) {
      const wanted = String(variables.name).toLowerCase();
      return Response.json({ data: { issueLabels: { nodes: labels.filter((l) => l.name.toLowerCase() === wanted) } } });
    }
    if (query.includes("issueCreate")) return Response.json({ data: { issueCreate: { success: true, issue: summary } } });
    if (query.includes("issueAddLabel")) return Response.json({ data: { issueAddLabel: { success: true, issue: summary } } });
    if (query.includes("issue(id")) return Response.json({ data: { issue: variables.id === "ENG-404" ? null : { id: "I1", team: { key: "ENG" } } } });
    return Response.json({ errors: [{ message: "unexpected" }] });
  }) as unknown as typeof fetch;
  return { fn, calls, writes: () => calls.filter((c) => c.query.includes("mutation")) };
};

describe("write tool registration", () => {
  test("write tools are only built for configured integrations and every one is kind write", () => {
    expect(buildWriteTools({})).toEqual([]);
    const linear = buildWriteTools({ linear: { apiKey: LINEAR_KEY } });
    expect(linear.map((t) => t.name)).toEqual(["linear.createIssue", "linear.addLabel"]);
    const github = buildWriteTools({ github: { token: GH_TOKEN, repo: { owner: "acme", name: "app" }, workflowFiles: ["linear-implement.yml"], observe: UNOBSERVED } });
    expect(github.map((t) => t.name)).toEqual(["github.createIssue", "github.dispatchWorkflow"]);
    for (const tool of [...linear, ...github]) expect(tool.kind).toBe("write");
    for (const tool of buildReadTools({ linear: { apiKey: LINEAR_KEY } })) expect(tool.kind).toBe("read");
  });

  test("without a configured workflow file there is no dispatch tool", () => {
    const tools = buildWriteTools({ github: { token: GH_TOKEN, repo: { owner: "acme", name: "app" }, workflowFiles: [], observe: UNOBSERVED } });
    expect(tools.map((t) => t.name)).toEqual(["github.createIssue"]);
  });

  test("the addLabel description says the trigger label starts the implementation", () => {
    const tools = buildWriteTools({ linear: { apiKey: LINEAR_KEY, triggerLabel: "Codex" } });
    expect(named(tools, "linear.addLabel").description).toContain('"Codex" starts the automation that implements the issue');
  });
});

describe("linear write tools", () => {
  test("createIssue resolves the only team, creates the issue and returns the link", async () => {
    const fake = linearFake();
    const tools = buildWriteTools({ linear: { apiKey: LINEAR_KEY }, fetch: fake.fn });
    const result = await executeTool(named(tools, "linear.createIssue"), { title: "Billing bug", description: "It 500s", labels: ["bug"] }, ctx);
    expect(result).toEqual({ ok: true, text: 'Created Linear issue ENG-7 "Billing bug": https://linear.app/acme/issue/ENG-7' });
    const [mutation] = fake.writes();
    expect(mutation!.variables.input).toEqual({ teamId: "T1", title: "Billing bug", description: "It 500s", labelIds: ["L1"] });
  });

  test("createIssue with several teams and no teamKey fails before any write", async () => {
    const fake = linearFake(undefined, [{ id: "T1", key: "ENG" }, { id: "T2", key: "OPS" }]);
    const tools = buildWriteTools({ linear: { apiKey: LINEAR_KEY }, fetch: fake.fn });
    const result = await executeTool(named(tools, "linear.createIssue"), { title: "x" }, ctx);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("teamKey is required. Teams: ENG, OPS");
    expect(fake.writes()).toHaveLength(0);
  });

  test("createIssue with a label that does not exist fails and never creates an issue or a label", async () => {
    const fake = linearFake();
    const tools = buildWriteTools({ linear: { apiKey: LINEAR_KEY }, fetch: fake.fn });
    const result = await executeTool(named(tools, "linear.createIssue"), { title: "x", labels: ["nope"] }, ctx);
    expect(!result.ok && result.error).toContain('label "nope" does not exist');
    expect(fake.writes()).toHaveLength(0);
  });

  test("addLabel resolves the label by name, ignoring case, and calls issueAddLabel once", async () => {
    const fake = linearFake([{ id: "L9", name: "Codex", team: null }]);
    const tools = buildWriteTools({ linear: { apiKey: LINEAR_KEY, triggerLabel: "codex" }, fetch: fake.fn });
    const result = await executeTool(named(tools, "linear.addLabel"), { issue: "eng-7", label: "codex" }, ctx);
    expect(result.ok && result.text).toContain("This label starts the implementation run.");
    expect(fake.writes()).toHaveLength(1);
    expect(fake.writes()[0]!.variables).toEqual({ id: "I1", labelId: "L9" });
  });

  test("addLabel with a missing label errors and writes nothing, so no label is created implicitly", async () => {
    const fake = linearFake();
    const tools = buildWriteTools({ linear: { apiKey: LINEAR_KEY }, fetch: fake.fn });
    const result = await executeTool(named(tools, "linear.addLabel"), { issue: "ENG-7", label: "ship-it" }, ctx);
    expect(!result.ok && result.error).toContain("never created automatically");
    expect(fake.writes()).toHaveLength(0);
  });

  test("addLabel on an unknown issue errors", async () => {
    const fake = linearFake();
    const tools = buildWriteTools({ linear: { apiKey: LINEAR_KEY }, fetch: fake.fn });
    const result = await executeTool(named(tools, "linear.addLabel"), { issue: "ENG-404", label: "Bug" }, ctx);
    expect(!result.ok && result.error).toContain("was not found");
    expect(fake.writes()).toHaveLength(0);
  });

  test("a dry run validates the args and returns what it would do without any request", async () => {
    const fake = linearFake();
    const tools = buildWriteTools({ linear: { apiKey: LINEAR_KEY }, fetch: fake.fn });
    const result = await executeTool(named(tools, "linear.createIssue"), { title: "Billing bug" }, { ...ctx, dryRun: true });
    expect(result.ok && result.text).toBe('dry-run: would run linear.createIssue {"title":"Billing bug"}');
    expect(fake.calls).toHaveLength(0);
  });

  test("invalid args are rejected before anything runs", async () => {
    const fake = linearFake();
    const tools = buildWriteTools({ linear: { apiKey: LINEAR_KEY }, fetch: fake.fn });
    const result = await executeTool(named(tools, "linear.createIssue"), { title: "" }, ctx);
    expect(!result.ok && result.error).toContain("Invalid arguments");
    expect(fake.calls).toHaveLength(0);
  });
});

type GhCall = { method: string; path: string; body: any; headers: Record<string, string> };

const githubFake = () => {
  const calls: GhCall[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ method: init?.method ?? "GET", path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.pathname === "/repos/acme/app") return Response.json({ default_branch: "main" });
    if (url.pathname === "/repos/acme/app/issues") return Response.json({ number: 12, html_url: "https://github.com/acme/app/issues/12" });
    if (url.pathname.endsWith("/dispatches")) return new Response(null, { status: 204 });
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  return { fn, calls, writes: () => calls.filter((c) => c.method === "POST") };
};

describe("github write tools", () => {
  const config = (fn: typeof fetch) => buildWriteTools({ github: { token: GH_TOKEN, repo: { owner: "acme", name: "app" }, workflowFiles: ["linear-implement.yml", "codex-issue-fix.yml"], observe: UNOBSERVED }, fetch: fn });

  test("createIssue posts to the configured repository only and returns the link", async () => {
    const fake = githubFake();
    const result = await executeTool(named(config(fake.fn), "github.createIssue"), { title: "Billing", body: "It 500s", labels: ["bug"] }, ctx);
    expect(result).toEqual({ ok: true, text: 'Created GitHub issue #12 "Billing": https://github.com/acme/app/issues/12' });
    expect(fake.writes()).toEqual([expect.objectContaining({ path: "/repos/acme/app/issues", body: { title: "Billing", body: "It 500s", labels: ["bug"] } })]);
  });

  test("dispatchWorkflow starts an allowlisted workflow on the default branch", async () => {
    const fake = githubFake();
    const result = await executeTool(named(config(fake.fn), "github.dispatchWorkflow"), { workflowFile: "codex-issue-fix.yml", inputs: { issue: "12" } }, ctx);
    expect(result).toEqual({ ok: true, text: "Started workflow codex-issue-fix.yml in acme/app on main" });
    expect(fake.writes()).toEqual([expect.objectContaining({ path: "/repos/acme/app/actions/workflows/codex-issue-fix.yml/dispatches", body: { ref: "main", inputs: { issue: "12" }, return_run_details: true } })]);
  });

  test("dispatchWorkflow refuses a workflow that is not in the allowlist and sends nothing", async () => {
    const fake = githubFake();
    const result = await executeTool(named(config(fake.fn), "github.dispatchWorkflow"), { workflowFile: "deploy-prod.yml" }, ctx);
    expect(!result.ok && result.error).toContain("not an allowed workflow");
    expect(fake.calls).toHaveLength(0);
  });

  test("dispatchWorkflow rejects a path-like file name at validation", async () => {
    const fake = githubFake();
    const tool = named(config(fake.fn), "github.dispatchWorkflow");
    expect((await executeTool(tool, { workflowFile: "../x.yml" }, ctx)).ok).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  test("dispatchWorkflow has no ref argument and ignores one the model sends", async () => {
    const fake = githubFake();
    const tool = named(config(fake.fn), "github.dispatchWorkflow");
    expect(JSON.stringify(z.toJSONSchema(tool.argsSchema))).not.toContain('"ref"');
    const result = await executeTool(tool, { workflowFile: "codex-issue-fix.yml", ref: "evil-branch" }, ctx);
    expect(result).toEqual({ ok: true, text: "Started workflow codex-issue-fix.yml in acme/app on main" });
    expect(fake.writes()).toEqual([expect.objectContaining({ body: { ref: "main", inputs: {}, return_run_details: true } })]);
  });

  test("dispatchWorkflow uses the configured ref of that workflow file", async () => {
    const fake = githubFake();
    const tools = buildWriteTools({
      github: { token: GH_TOKEN, repo: { owner: "acme", name: "app" }, workflowFiles: ["linear-implement.yml", "codex-issue-fix.yml"], observe: UNOBSERVED, workflowRefs: { "linear-implement.yml": "release" } },
      fetch: fake.fn,
    });
    const tool = named(tools, "github.dispatchWorkflow");
    expect(await executeTool(tool, { workflowFile: "linear-implement.yml" }, ctx)).toEqual({ ok: true, text: "Started workflow linear-implement.yml in acme/app on release" });
    expect(await executeTool(tool, { workflowFile: "codex-issue-fix.yml" }, ctx)).toEqual({ ok: true, text: "Started workflow codex-issue-fix.yml in acme/app on main" });
  });

  test("a failing GitHub call never leaks the token", async () => {
    const fn = (async () => Response.json({ message: `Bad credentials ${GH_TOKEN}` }, { status: 401 })) as unknown as typeof fetch;
    const result = await executeTool(named(config(fn), "github.createIssue"), { title: "x", body: "y" }, ctx);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(GH_TOKEN);
  });

  test("a dry run never reaches GitHub", async () => {
    const fake = githubFake();
    const result = await executeTool(named(config(fake.fn), "github.createIssue"), { title: "x", body: "y" }, { ...ctx, dryRun: true });
    expect(result.ok && result.text).toStartWith("dry-run: would run github.createIssue");
    expect(fake.calls).toHaveLength(0);
  });
});

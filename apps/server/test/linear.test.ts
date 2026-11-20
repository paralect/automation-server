import { createDispatcher, createSqliteActivityStore, createSqliteStore, type Logger } from "@automation-server/core";
import { createWorkflowInstaller } from "@automation-server/api/workflowInstaller";
import { createSqliteSettingsStore, envFor, resolveConfig } from "@automation-server/settings";
import { describe, expect, test } from "bun:test";
import { workKey } from "@automation-server/ledger";
import { createSqliteLedger } from "@automation-server/ledger/server";
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGithubActionsReader } from "@automation-server/api/githubActions";

import { createApp } from "../src/app";
import { INTEGRATION_MODULES } from "../src/integrations/registry";
import { createBudgetAlerter } from "../src/budget";
import { createLedgerObserver } from "../src/ledgerObserver";
import { createRuntime } from "../src/runtime";

const SECRET = "lin_wh_secret";
const GH_TOKEN = "ghp_linear_test_token";
const fixture = JSON.parse(
  readFileSync(new URL("../../../packages/sources/test/fixtures/linear-issue-label-added.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

type Call = { method: string; path: string; body: unknown };

function setup(values: { linear?: boolean; github?: boolean; workflowStatus?: number; ledgerPath?: string } = {}) {
  const { linear = true, github = true, workflowStatus = 204, ledgerPath = ":memory:" } = values;
  const calls: Call[] = [];
  const logs: string[] = [];
  const fakeGithub = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "GET" && path === "/repos/acme/app") return Response.json({ default_branch: "main" });
    if (method === "GET" && path.endsWith("/actions/workflows/linear-implement.yml")) return Response.json({ state: "active" });
    if (method === "POST" && path.endsWith("/dispatches")) {
      return workflowStatus === 204 ? new Response(null, { status: 204 }) : Response.json({ message: "Not Found" }, { status: workflowStatus });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  const record = (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f }));
  const log: Logger = { info: record, warn: record, error: record };

  const settings = createSqliteSettingsStore({ path: ":memory:", encryptionKey: "k" });
  const set = (key: string, value: unknown, secret = false) => ({ key, json: JSON.stringify(value), secret });
  settings.apply({
    set: [
      ...(linear
        ? [set("linear.webhookSecret", SECRET, true), set("linear.triggerLabel", "codex"), set("linear.targetRepo", "acme/app")]
        : []),
      ...(github ? [set("github.token", GH_TOKEN, true)] : []),
    ],
  });
  const resolve = (p: string) => resolveConfig(settings.project(p), envFor(p, {}));
  const ledger = createSqliteLedger({ path: ledgerPath });
  const budget = createBudgetAlerter({ ledger, resolve, log });
  const runtime = createRuntime({
    observerFor: (project) => createLedgerObserver({ project, ledger, budget, log }),
    modules: INTEGRATION_MODULES,
    projects: () => settings.projects().map((p) => p.id),
    resolve,
    deps: { log, fetch: fakeGithub },
  });
  const activity = createSqliteActivityStore({ path: ":memory:" });
  const dispatcher = createDispatcher({ automations: runtime.automations, store: createSqliteStore({ path: ":memory:" }), log, activity });
  const app = createApp({
    source: runtime.source,
    defaultProject: "default",
    dispatcher,
    log,
    admin: {
      activity,
      ledger,
      outcomes: { syncNow: async () => ({ status: "not-configured" as const, message: "unused" }) },
      actions: () => createGithubActionsReader({ repos: [], token: "t", fetch: fakeGithub }),
      adminToken: undefined,
      settings: { db: settings, env: {}, reload: runtime.rebuild, test: runtime.test, health: () => ({}) },
      workflows: () => createWorkflowInstaller({ token: undefined }),
      posthog: {
        preview: async () => ({ ok: false as const, message: "unused" }),
        runNow: async () => ({ status: "busy" as const, message: "unused" }),
      },
      replay: { event: async () => ({ outcome: "unknown-automation" as const }), job: async () => ({ status: "unknown-job" as const }) },
      slackDirectory: { list: async () => ({ items: [], truncated: false }) },
      system: () => ({ startedAt: "", sources: [], automations: [], jobs: [], retentionDays: 30, webhookUrls: {} }),
    },
  });

  const deliver = (patch: Record<string, unknown> = {}) => {
    const body = new TextEncoder().encode(JSON.stringify({ ...fixture, webhookTimestamp: Date.now(), ...patch }));
    const signature = createHmac("sha256", SECRET).update(body).digest("hex");
    return app.request("/webhooks/linear", { method: "POST", body, headers: { "linear-signature": signature } });
  };
  const dispatches = () => calls.filter((c) => c.path.endsWith("/dispatches"));
  return { runtime, dispatcher, activity, ledger, calls, logs, deliver, dispatches };
}

describe("linear integration", () => {
  test("is not served until the linear settings are configured", async () => {
    const t = setup({ linear: false });
    expect((await t.deliver()).status).toBe(404);
    expect(t.runtime.automations().map((a) => a.name)).not.toContain("linear-label-to-pr");
  });

  test("without a GitHub token the webhook is accepted but nothing is dispatched", async () => {
    const t = setup({ github: false });
    expect((await t.deliver()).status).toBe(200);
    await t.dispatcher.drain(2000);
    expect(t.runtime.automations()).toHaveLength(0);
    expect(t.calls).toHaveLength(0);
  });

  test("a signed label-added webhook dispatches the workflow once, and a redelivery is a duplicate", async () => {
    const t = setup();
    expect((await t.deliver()).status).toBe(200);
    await t.dispatcher.drain(2000);
    expect(t.dispatches()).toEqual([
      {
        method: "POST",
        path: "/repos/acme/app/actions/workflows/linear-implement.yml/dispatches",
        body: {
          ref: "main",
          inputs: {
            issue_identifier: "ENG-42",
            issue_title: "Fix login redirect",
            issue_url: "https://linear.app/acme/issue/ENG-42/fix-login",
            issue_description: "Users land on a 404 after login.",
          },
          return_run_details: true,
        },
      },
    ]);
    await t.deliver();
    await t.dispatcher.drain(2000);
    expect(t.dispatches()).toHaveLength(1);
    expect(t.logs.join("\n")).not.toContain(GH_TOKEN);
    expect(t.logs.join("\n")).not.toContain("Users land on a 404");
  });

  test("a missing workflow fails the run with a message that points at the Workflows page", async () => {
    const t = setup({ workflowStatus: 404 });
    await t.deliver();
    await t.dispatcher.drain(2000);
    const runs = t.activity.queryRuns({ limit: 10 }).items;
    expect(runs[0]).toMatchObject({ automation: "linear-label-to-pr", status: "failed" });
    expect(runs[0]?.error).toContain("admin Workflows page");
  });

  test("the connection test checks that the workflow is installed and active", async () => {
    const t = setup();
    expect(await t.runtime.test("default", "linear")).toMatchObject({ ok: true, message: "Webhook is ready and linear-implement.yml is active in acme/app" });
  });

  test("the dispatch is recorded on its run as the Linear work item, keeping the issue link and none of the issue text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    try {
      const ledgerPath = join(dir, "automation.db");
      const t = setup({ ledgerPath });
      await t.deliver();
      await t.dispatcher.drain(2000);
      const run = t.activity.queryRuns({ limit: 1 }).items[0];
      expect(run).toMatchObject({ automation: "linear-label-to-pr", status: "succeeded" });
      const trace = t.ledger.trace("default", run?.id ?? "", new Date());
      expect(trace.workItems).toEqual([
        {
          key: workKey({ kind: "linear-issue", identifier: "ENG-42" }),
          ref: { kind: "linear-issue", identifier: "ENG-42" },
          url: "https://linear.app/acme/issue/ENG-42/fix-login",
          createdByThisRun: false,
          dispatches: [{ at: expect.any(String), workflowFile: "linear-implement.yml", ref: "main" }],
          workflowRuns: [],
          pullRequests: [],
          missingRun: false,
        },
      ]);
      t.ledger.close();
      const raw = new Database(ledgerPath, { readonly: true });
      const tables = raw.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      const dump = JSON.stringify(tables.map(({ name }) => raw.query(`SELECT * FROM "${name}"`).all()));
      raw.close();
      expect(dump).toContain("ENG-42");
      expect(dump).not.toContain("Users land on a 404");
      expect(dump).not.toContain("Fix login redirect");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

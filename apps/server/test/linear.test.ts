import { createDispatcher, createSqliteActivityStore, createSqliteStore, type Logger } from "@automation-server/core";
import { createWorkflowInstaller } from "@automation-server/api/workflowInstaller";
import { createSqliteSettingsStore, resolveConfig } from "@automation-server/settings";
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import { createGithubActionsReader } from "@automation-server/api/githubActions";

import { createApp } from "../src/app";
import { INTEGRATION_MODULES } from "../src/integrations/registry";
import { createRuntime } from "../src/runtime";

const SECRET = "lin_wh_secret";
const GH_TOKEN = "ghp_linear_test_token";
const fixture = JSON.parse(
  readFileSync(new URL("../../../packages/sources/test/fixtures/linear-issue-label-added.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

type Call = { method: string; path: string; body: unknown };

function setup(values: { linear?: boolean; github?: boolean; workflowStatus?: number } = {}) {
  const { linear = true, github = true, workflowStatus = 204 } = values;
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
  const runtime = createRuntime({ modules: INTEGRATION_MODULES, resolve: () => resolveConfig(settings, {}), deps: { log, fetch: fakeGithub } });
  const activity = createSqliteActivityStore({ path: ":memory:" });
  const dispatcher = createDispatcher({ automations: runtime.automations, store: createSqliteStore({ path: ":memory:" }), log, activity });
  const app = createApp({
    sources: runtime.sources,
    dispatcher,
    log,
    admin: {
      activity,
      actions: () => createGithubActionsReader({ repos: [], token: "t", fetch: fakeGithub }),
      adminToken: undefined,
      settings: { store: settings, env: {}, reload: runtime.rebuild, test: runtime.test },
      workflows: () => createWorkflowInstaller({ token: undefined }),
      posthog: {
        preview: async () => ({ ok: false as const, message: "unused" }),
        runNow: async () => ({ status: "busy" as const, message: "unused" }),
      },
      system: () => ({ startedAt: "", sources: [], automations: [], jobs: [], retentionDays: 30, webhookUrls: {} }),
    },
  });

  const deliver = (patch: Record<string, unknown> = {}) => {
    const body = new TextEncoder().encode(JSON.stringify({ ...fixture, webhookTimestamp: Date.now(), ...patch }));
    const signature = createHmac("sha256", SECRET).update(body).digest("hex");
    return app.request("/webhooks/linear", { method: "POST", body, headers: { "linear-signature": signature } });
  };
  const dispatches = () => calls.filter((c) => c.path.endsWith("/dispatches"));
  return { runtime, dispatcher, activity, calls, logs, deliver, dispatches };
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
    expect(await t.runtime.test("linear")).toMatchObject({ ok: true, message: "Webhook is ready and linear-implement.yml is active in acme/app" });
  });
});

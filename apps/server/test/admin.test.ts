import { createDispatcher, createScheduler, createSqliteActivityStore, createSqliteStore, type ClaimStore, type Logger } from "@automation-server/core";
import { createSqliteHealthStore, createSqliteSettingsStore, envFor, resolveConfig } from "@automation-server/settings";
import { describe, expect, test } from "bun:test";

import { createGithubActionsReader } from "@automation-server/api/githubActions";
import { createWorkflowInstaller } from "@automation-server/api/workflowInstaller";

import { createApp } from "../src/app";
import { webhookUrls } from "../src/config";
import { createPosthogAdmin } from "../src/integrations/posthog";
import { INTEGRATION_MODULES } from "../src/integrations/registry";
import { createReplayAdmin } from "../src/replay";
import { createHealthSink } from "../src/health";
import { createRuntime } from "../src/runtime";

const TOKEN = "t".repeat(40);
const quiet: Logger = { info() {}, warn() {}, error() {} };

const withProject = (path: string, input: unknown) =>
  path.startsWith("projects/") || (input !== undefined && (typeof input !== "object" || input === null || "project" in input))
    ? input
    : { project: "default", ...(input as object | undefined) };

function setup(options: { adminToken?: string; encryptionKey?: string; env?: Record<string, string>; githubFetch?: typeof fetch; workflowsFetch?: typeof fetch; claims?: ClaimStore } = { adminToken: TOKEN }) {
  const { adminToken, encryptionKey, env = {}, githubFetch, workflowsFetch, claims } = options;
  const settings = createSqliteSettingsStore({ path: ":memory:", encryptionKey });
  const resolve = (p: string) => resolveConfig(settings.project(p), envFor(p, env));
  const healthStore = createSqliteHealthStore({ path: ":memory:" });
  const health = createHealthSink({ store: healthStore, notify: async () => {} });
  const runtime = createRuntime({ modules: INTEGRATION_MODULES, projects: () => settings.projects().map((p) => p.id), resolve, deps: { log: quiet, fetch: githubFetch }, health });
  const activity = createSqliteActivityStore({ path: ":memory:" });
  const store = claims ?? createSqliteStore({ path: ":memory:" });
  const dispatcher = createDispatcher({ automations: runtime.automations, store, log: quiet, activity });
  const scheduler = createScheduler({ jobs: runtime.jobs, store, log: quiet, activity });
  const app = createApp({
    source: runtime.source,
    defaultProject: "default",
    dispatcher,
    log: quiet,
    admin: {
      activity,
      actions: () => createGithubActionsReader({
        repos: ["acme/widgets"],
        token: "gh",
        fetch: (async (url: string | URL | Request) => {
          const path = new URL(String(url)).pathname;
          if (path.endsWith("/actions/workflows")) return Response.json({ workflows: [{ id: 1, name: "CI" }] });
          if (path.endsWith("/actions/runs")) return Response.json({ workflow_runs: [] });
          return new Response("{}", { status: 404 });
        }) as typeof fetch,
      }),
      workflows: (project) => createWorkflowInstaller({ token: resolve(project).github.values.token, fetch: workflowsFetch }),
      adminToken,
      settings: { db: settings, env, reload: runtime.rebuild, test: runtime.test, health: healthStore.get },
      posthog: createPosthogAdmin({ resolve, scheduler, fetch: githubFetch }),
      replay: createReplayAdmin({ dispatcher, scheduler, jobs: (project) => runtime.project(project).jobs }),
      system: (project) => ({
        startedAt: new Date().toISOString(),
        sources: Object.keys(runtime.sources(project)),
        automations: runtime.project(project).automations.map((a) => a.name),
        jobs: runtime.project(project).jobs.map((j) => j.name),
        retentionDays: 30,
        webhookUrls: webhookUrls(project, ["sentry", "linear"], "https://hooks.example.com"),
      }),
    },
  });
  const call = (path: string, input: unknown, bearer?: string) =>
    app.request(`/rpc/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify({ json: withProject(path, input) }),
    });
  return { activity, call, app, settings, runtime };
}

describe("admin API auth", () => {
  test("no token gives 401", async () => {
    expect((await setup().call("overview", {})).status).toBe(401);
  });

  test("wrong token gives 401", async () => {
    expect((await setup().call("overview", {}, "w".repeat(40))).status).toBe(401);
  });

  test("a bearer is rejected when ADMIN_API_TOKEN is unset", async () => {
    const t = setup({});
    expect((await t.call("overview", {}, TOKEN)).status).toBe(401);
    expect((await t.call("system", undefined, "undefined")).status).toBe(401);
  });

  test("the correct token reads the overview", async () => {
    const t = setup();
    t.activity.recordDuplicate({ project: "default", automation: "a", source: "s", kind: "k", externalId: "e", startedAt: new Date().toISOString() });
    const res = await t.call("overview", {}, TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json: { runs: Record<string, number> } };
    expect(body.json.runs.duplicate).toBe(1);
  });

  test("runs.get for an unknown id gives 404", async () => {
    expect((await setup().call("runs/get", { id: "nope" }, TOKEN)).status).toBe(404);
  });

  test("runs.get returns a stored run with its logs", async () => {
    const t = setup();
    const id = t.activity.startRun({ project: "default", automation: "a", source: "s", kind: "k", externalId: "e", startedAt: new Date().toISOString() });
    t.activity.recordLog({ time: new Date().toISOString(), level: "info", message: "hello", fields: { runId: id } });
    const res = await t.call("runs/get", { id }, TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json: { run: { id: string }; logs: { message: string }[] } };
    expect(body.json.run.id).toBe(id);
    expect(body.json.logs.map((l) => l.message)).toEqual(["hello"]);
  });

  test("runs.get returns the stored event while runs.list only flags it", async () => {
    const t = setup();
    const event = { project: "default", source: "s", kind: "k", externalId: "e", receivedAt: "2026-01-01T00:00:00.000Z", payload: { password: "p", title: "t" } };
    const id = t.activity.startRun({ project: "default", automation: "a", source: "s", kind: "k", externalId: "e", startedAt: new Date().toISOString(), event });
    const got = (await (await t.call("runs/get", { id }, TOKEN)).json()) as { json: { event: { payload: unknown } } };
    expect(got.json.event.payload).toEqual({ password: "[redacted]", title: "t" });
    const listed = (await (await t.call("runs/list", {}, TOKEN)).json()) as { json: { items: Record<string, unknown>[] } };
    expect(listed.json.items[0]).toMatchObject({ hasEvent: true });
    expect(listed.json.items[0]).not.toHaveProperty("event");
  });

  test("actions.list needs the token and lists configured repos", async () => {
    const t = setup();
    expect((await t.call("actions/list", {})).status).toBe(401);
    const res = await t.call("actions/list", {}, TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json: { repos: string[]; workflows: string[] } };
    expect(body.json).toMatchObject({ repos: ["acme/widgets"], workflows: ["CI"] });
  });

  test("actions.get refuses a repository that is not configured", async () => {
    expect((await setup().call("actions/get", { repo: "evil/repo", id: 1 }, TOKEN)).status).toBe(404);
  });
});

describe("settings API", () => {
  const rpc = async (t: ReturnType<typeof setup>, path: string, input: unknown) => {
    const res = await t.call(path, input, TOKEN);
    const body = (await res.json()) as { json: any };
    return { status: res.status, body: body.json };
  };
  const field = (view: any, id: string, key: string) =>
    view.integrations.find((i: any) => i.id === id).fields.find((f: any) => f.key === key);
  const sentryWebhook = (t: ReturnType<typeof setup>) =>
    t.app.request("/webhooks/sentry", { method: "POST", body: "{}", headers: { "sentry-hook-signature": "bad" } });

  test("needs the admin token", async () => {
    const t = setup({ adminToken: TOKEN, encryptionKey: "k" });
    expect((await t.call("settings/get", undefined)).status).toBe(401);
    expect((await t.call("settings/update", { integrationId: "sentry", values: {} })).status).toBe(401);
    expect((await t.call("settings/testConnection", { integrationId: "github" })).status).toBe(401);
  });

  test("saving the sentry client secret registers the source without a restart and never echoes the secret", async () => {
    const t = setup({ adminToken: TOKEN, encryptionKey: "k" });
    expect((await sentryWebhook(t)).status).toBe(404);

    const saved = await rpc(t, "settings/update", { integrationId: "sentry", values: { clientSecret: "super-secret-value", minEventCount: 3 } });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain("super-secret-value");
    expect(field(saved.body, "sentry", "clientSecret")).toMatchObject({ set: true, source: "db" });
    expect(field(saved.body, "sentry", "minEventCount")).toMatchObject({ value: 3, source: "db" });

    expect((await sentryWebhook(t)).status).toBe(401);
    const got = await rpc(t, "settings/get", undefined);
    expect(JSON.stringify(got.body)).not.toContain("super-secret-value");
    expect(got.body.integrations.find((i: any) => i.id === "sentry").configured).toBe(true);
    expect((await rpc(t, "system", undefined)).body.sources).toEqual(["sentry"]);
  });

  test("clear removes a key and the source goes away again", async () => {
    const t = setup({ adminToken: TOKEN, encryptionKey: "k" });
    await rpc(t, "settings/update", { integrationId: "sentry", values: { clientSecret: "abc" } });
    expect((await sentryWebhook(t)).status).toBe(401);
    const cleared = await rpc(t, "settings/update", { integrationId: "sentry", clear: ["clientSecret"] });
    expect(field(cleared.body, "sentry", "clientSecret")).toMatchObject({ set: false, source: "unset" });
    expect((await sentryWebhook(t)).status).toBe(404);
  });

  test("an empty secret keeps the stored one", async () => {
    const t = setup({ adminToken: TOKEN, encryptionKey: "k" });
    await rpc(t, "settings/update", { integrationId: "sentry", values: { clientSecret: "abc" } });
    await rpc(t, "settings/update", { integrationId: "sentry", values: { clientSecret: "", apiBaseUrl: "https://s.example" } });
    const got = await rpc(t, "settings/get", undefined);
    expect(field(got.body, "sentry", "clientSecret").set).toBe(true);
    expect(field(got.body, "sentry", "apiBaseUrl").value).toBe("https://s.example");
  });

  test("writing a secret without SETTINGS_ENCRYPTION_KEY is rejected and writes nothing, plain fields still work", async () => {
    const t = setup({ adminToken: TOKEN });
    const rejected = await rpc(t, "settings/update", { integrationId: "sentry", values: { clientSecret: "abc", minEventCount: 2 } });
    expect(rejected.status).toBe(400);
    expect(JSON.stringify(rejected.body)).toContain("SETTINGS_ENCRYPTION_KEY");
    const plain = await rpc(t, "settings/update", { integrationId: "sentry", values: { minEventCount: 2 } });
    expect(plain.status).toBe(200);
    expect(plain.body.secretsWritable).toBe(false);
    expect(field(plain.body, "sentry", "minEventCount").value).toBe(2);
  });

  test("invalid input is a 400", async () => {
    const t = setup({ adminToken: TOKEN, encryptionKey: "k" });
    expect((await rpc(t, "settings/update", { integrationId: "posthog", values: { dayOfWeek: 9 } })).status).toBe(400);
    expect((await rpc(t, "settings/update", { integrationId: "sentry", values: { nope: 1 } })).status).toBe(400);
    expect((await rpc(t, "settings/update", { integrationId: "nope", values: {} })).status).toBe(400);
  });

  test("env values are shown as env and an env-only deployment is configured with no db rows", async () => {
    const t = setup({ adminToken: TOKEN, env: { SENTRY_CLIENT_SECRET: "s", GITHUB_TOKEN: "t", GITHUB_REPO: "acme/widgets" } });
    const got = await rpc(t, "settings/get", undefined);
    expect(field(got.body, "sentry", "clientSecret")).toMatchObject({ set: true, source: "env" });
    expect(field(got.body, "github", "repo")).toMatchObject({ value: "acme/widgets", source: "env" });
    expect((await rpc(t, "system", undefined)).body).toMatchObject({
      sources: ["sentry"],
      automations: ["sentry-to-github-issue"],
      webhookUrls: { sentry: "https://hooks.example.com/webhooks/default/sentry" },
    });
  });

  test("testConnection for github calls /user and the repository and reports without the token", async () => {
    const paths: string[] = [];
    const githubFetch = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === "/user") return Response.json({ login: "octo" });
      return Response.json({ private: true, permissions: { push: true } });
    }) as typeof fetch;
    const t = setup({ adminToken: TOKEN, githubFetch, env: { GITHUB_TOKEN: "ghp_topsecret", GITHUB_REPO: "acme/widgets" } });
    const res = await rpc(t, "settings/testConnection", { integrationId: "github" });
    expect(res.body).toMatchObject({ ok: true, available: true, details: { user: "octo", repo: "acme/widgets", visibility: "private" } });
    expect(paths).toEqual(["/user", "/repos/acme/widgets"]);
    expect(JSON.stringify(res.body)).not.toContain("ghp_topsecret");
  });

  test("a testConnection result is persisted and settings/get returns it as health with its expiry", async () => {
    const githubFetch = (async (url: string | URL | Request) =>
      new URL(String(url)).pathname === "/user"
        ? Response.json({ login: "octo" }, { headers: { "github-authentication-token-expiration": "2026-12-01 10:00:00 UTC" } })
        : Response.json({ private: true })) as typeof fetch;
    const t = setup({ adminToken: TOKEN, githubFetch, env: { GITHUB_TOKEN: "ghp_x", GITHUB_REPO: "acme/widgets" } });
    const before = (await rpc(t, "settings/get", undefined)).body.integrations.find((i: { id: string }) => i.id === "github");
    expect(before.health).toBeUndefined();
    await rpc(t, "settings/testConnection", { integrationId: "github" });
    const after = (await rpc(t, "settings/get", undefined)).body.integrations.find((i: { id: string }) => i.id === "github");
    expect(after.health).toMatchObject({ ok: true, expiresAt: "2026-12-01T10:00:00.000Z" });
    expect(typeof after.health.checkedAt).toBe("string");
  });

  test("testConnection reports a rejected token, an unconfigured integration and not-yet-available ones", async () => {
    const rejecting = (async (_url: string | URL | Request) => new Response("{}", { status: 401 })) as typeof fetch;
    const bad = setup({ adminToken: TOKEN, githubFetch: rejecting, env: { GITHUB_TOKEN: "x" } });
    expect((await rpc(bad, "settings/testConnection", { integrationId: "github" })).body).toMatchObject({ ok: false, available: true });

    const none = setup({ adminToken: TOKEN });
    for (const integrationId of ["github", "linear", "posthog", "sentry"]) {
      expect((await rpc(none, "settings/testConnection", { integrationId })).body).toMatchObject({ ok: false, message: expect.stringContaining("not configured") });
    }
  });
});

describe("posthog API", () => {
  const API_KEY = "phx_AdminTestKey0987654321";
  const SLACK_URL = "https://hooks.slack.com/services/T1/B1/adminTestWebhookSecret";

  const rpc = async (t: ReturnType<typeof setup>, path: string, input?: unknown) => {
    const res = await t.call(path, input, TOKEN);
    const body = (await res.json()) as { json: any };
    return { status: res.status, body: body.json, raw: JSON.stringify(body) };
  };

  function posthogSetup(slack: (url: string) => Response = () => new Response("ok")) {
    const calls: string[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      calls.push(target);
      if (target === SLACK_URL) return slack(target);
      const query = (JSON.parse(String(init?.body)) as { query: { query: string } }).query.query;
      if (query.includes("uniqIf")) return Response.json({ results: [[10, 5, 100, 50, 20, 10]] });
      if (query.startsWith("SELECT count()")) return Response.json({ results: [[1234]] });
      return Response.json({ results: [["/", 7, 3]] });
    }) as typeof globalThis.fetch;
    const t = setup({ adminToken: TOKEN, encryptionKey: "k", githubFetch: fetch });
    const configure = (values: Record<string, unknown> = {}) =>
      rpc(t, "settings/update", { integrationId: "posthog", values: { projectId: "77", personalApiKey: API_KEY, slackWebhookUrl: SLACK_URL, ...values } });
    const slackPosts = () => calls.filter((c) => c === SLACK_URL).length;
    return { t, configure, calls, slackPosts };
  }

  test("needs the admin token", async () => {
    const { t } = posthogSetup();
    expect((await t.call("posthog/preview", undefined)).status).toBe(401);
    expect((await t.call("posthog/runNow", undefined)).status).toBe(401);
  });

  test("an unconfigured integration is reported, not thrown", async () => {
    const { t } = posthogSetup();
    expect((await rpc(t, "posthog/preview")).body).toEqual({ ok: false, message: expect.stringContaining("Missing: projectId, personalApiKey, slackWebhookUrl") });
    expect((await rpc(t, "posthog/runNow")).body).toMatchObject({ status: "not-configured" });
  });

  test("preview returns the report and does not send it or record a run", async () => {
    const { t, configure, calls, slackPosts } = posthogSetup();
    await configure();
    const res = await rpc(t, "posthog/preview");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, text: expect.stringContaining("Unique users: *10* (+100.0%, was 5)") });
    expect(calls).toHaveLength(4);
    expect(slackPosts()).toBe(0);
    expect(t.activity.queryRuns({ limit: 10 }).items).toEqual([]);
    expect(res.raw).not.toContain(API_KEY);
  });

  test("runNow sends while the schedule is disabled and records a schedule run", async () => {
    const { t, configure, slackPosts } = posthogSetup();
    await configure();
    expect((await rpc(t, "system")).body.jobs).toEqual(["token-health"]);

    const res = await rpc(t, "posthog/runNow");
    expect(res.body).toMatchObject({ status: "succeeded", key: expect.stringMatching(/^manual:/), message: "Report sent to Slack" });
    expect(slackPosts()).toBe(1);
    const run = t.activity.queryRuns({ limit: 1 }).items[0];
    expect(run).toMatchObject({ id: res.body.runId, automation: "posthog-weekly-report", source: "schedule", externalId: res.body.key, status: "succeeded" });
  });

  test("a Slack failure comes back as a failed run without the webhook URL", async () => {
    const { t, configure } = posthogSetup((url) => new Response(`no_service ${url}`, { status: 404 }));
    await configure();
    const res = await rpc(t, "posthog/runNow");
    expect(res.body).toMatchObject({ status: "failed", message: expect.stringContaining("Slack delivery failed: HTTP 404") });
    expect(res.raw).not.toContain("adminTestWebhookSecret");
    expect(t.activity.queryRuns({ limit: 1 }).items[0]?.error).not.toContain("adminTestWebhookSecret");
  });

  test("the weekly job is registered only once enabled", async () => {
    const { t, configure } = posthogSetup();
    await configure({ enabled: true, dayOfWeek: 3, hourUtc: 7 });
    expect((await rpc(t, "system")).body.jobs).toEqual(["posthog-weekly-report", "token-health"]);
    await configure({ enabled: false });
    expect((await rpc(t, "system")).body.jobs).toEqual(["token-health"]);
  });

  test("testConnection runs a trivial query", async () => {
    const { t, configure, slackPosts } = posthogSetup();
    await configure();
    const res = await rpc(t, "settings/testConnection", { integrationId: "posthog" });
    expect(res.body).toMatchObject({ ok: true, details: { projectId: "77", eventsLastDay: "1234" } });
    expect(slackPosts()).toBe(0);
    expect(res.raw).not.toContain(API_KEY);
  });
});

describe("workflows API", () => {
  const rpc = async (t: ReturnType<typeof setup>, path: string, input: unknown) => {
    const res = await t.call(path, input, TOKEN);
    const body = (await res.json()) as { json: any };
    return { status: res.status, body: body.json };
  };

  test("needs the admin token", async () => {
    expect((await setup().call("workflows/templates", undefined)).status).toBe(401);
    expect((await setup().call("workflows/install", { repo: "acme/site", templateId: "codex-changelog" })).status).toBe(401);
  });

  test("templates lists the bundled workflows with their files and requirements, without contents", async () => {
    const res = await rpc(setup(), "workflows/templates", undefined);
    expect(res.status).toBe(200);
    expect(res.body).toContainEqual({
      id: "codex-changelog",
      title: "Codex changelog",
      description: expect.any(String),
      path: ".github/workflows/codex-changelog.yml",
      files: [".github/workflows/codex-changelog.yml", ".agents/skills/write-changelog/SKILL.md", ".agents/skills/write-changelog/agents/openai.yaml"],
      requiredSecrets: [["OPENAI_API_KEY", "CODEX_AUTH_JSON"]],
      requiredVariables: [],
      integration: null,
    });
    expect(res.body.find((t: { id: string }) => t.id === "linear-implement")?.integration).toEqual({
      integration: "linear",
      required: true,
      repoSetting: { integration: "linear", key: "targetRepo" },
    });
  });

  test("install without a GitHub token is a 412 that points at the Integrations page", async () => {
    const res = await rpc(setup(), "workflows/install", { repo: "acme/site", templateId: "codex-changelog" });
    expect(res.status).toBe(412);
    expect(res.body.message).toContain("Integrations page");
  });

  test("status and install use the configured token, GitHub failures are a 502 without the token", async () => {
    const seen: string[] = [];
    const workflowsFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const t = setup({ adminToken: TOKEN, workflowsFetch, env: { GITHUB_TOKEN: "ghp_topsecret" } });
    const status = await rpc(t, "workflows/status", { repo: "acme/site" });
    expect(status.status).toBe(502);
    expect(status.body.message).toContain("Repository acme/site was not found");
    expect(JSON.stringify(status.body)).not.toContain("ghp_topsecret");
    expect(seen).toEqual(["GET /repos/acme/site"]);
    const check = await rpc(t, "workflows/check", { repo: "acme/site", templateId: "linear-implement" });
    expect(check.status).toBe(502);
    expect(check.body.message).toContain("Repository acme/site was not found");

    expect((await rpc(t, "workflows/install", { repo: "acme/site", templateId: "nope" })).status).toBe(404);
    expect((await rpc(t, "workflows/status", { repo: "not a repo" })).status).toBe(400);
    expect((await rpc(t, "workflows/install", { repo: "acme/site", templateId: "codex-changelog", mode: "force" })).status).toBe(400);
  });
});

describe("projects API", () => {
  const rpc = async (t: ReturnType<typeof setup>, path: string, input?: unknown) => {
    const res = await t.call(path, input, TOKEN);
    const body = (await res.json()) as { json: any };
    return { status: res.status, body: body.json };
  };

  test("needs the admin token", async () => {
    const t = setup();
    expect((await t.call("projects/list", undefined)).status).toBe(401);
    expect((await t.call("projects/create", { name: "Acme" })).status).toBe(401);
  });

  test("create, rename and delete a project", async () => {
    const t = setup();
    const created = await rpc(t, "projects/create", { name: "Acme", domain: "https://acme.com/" });
    expect(created.body).toMatchObject({ id: "acme", name: "Acme", domain: "acme.com" });
    expect((await rpc(t, "projects/list")).body.map((p: any) => p.id)).toEqual(["default", "acme"]);
    expect((await rpc(t, "projects/update", { id: "acme", name: "Acme Inc" })).body).toMatchObject({ id: "acme", name: "Acme Inc", domain: "acme.com" });
    expect((await rpc(t, "projects/update", { id: "nope", name: "x" })).status).toBe(404);
    expect((await rpc(t, "projects/create", { name: "x", domain: "bad domain" })).status).toBe(400);
    expect((await rpc(t, "projects/delete", { id: "default" })).status).toBe(400);
    expect((await rpc(t, "projects/delete", { id: "acme" })).body).toEqual({ deleted: true });
    expect((await rpc(t, "projects/delete", { id: "acme" })).status).toBe(404);
  });

  test("a project's settings, system and runs are its own, and only the default project reads env", async () => {
    const t = setup({ adminToken: TOKEN, encryptionKey: "k", env: { SENTRY_CLIENT_SECRET: "s", GITHUB_TOKEN: "t", GITHUB_REPO: "acme/widgets" } });
    await rpc(t, "projects/create", { name: "Acme" });

    const acme = await rpc(t, "settings/get", { project: "acme" });
    expect(acme.body.integrations.every((i: any) => !i.configured)).toBe(true);
    expect((await rpc(t, "system", { project: "acme" })).body).toMatchObject({ sources: [], webhookUrls: { sentry: "https://hooks.example.com/webhooks/acme/sentry" } });

    await rpc(t, "settings/update", { project: "acme", integrationId: "sentry", values: { clientSecret: "acme-secret" } });
    expect((await rpc(t, "system", { project: "acme" })).body.sources).toEqual(["sentry"]);
    expect((await rpc(t, "system", { project: "acme" })).body.automations).toEqual([]);
    expect((await rpc(t, "system")).body.automations).toEqual(["sentry-to-github-issue"]);

    const run = t.activity.startRun({ project: "acme", automation: "a", source: "s", kind: "k", externalId: "e", startedAt: new Date().toISOString() });
    expect((await rpc(t, "runs/get", { project: "acme", id: run })).status).toBe(200);
    expect((await rpc(t, "runs/get", { id: run })).status).toBe(404);
    expect((await rpc(t, "runs/list", { project: "acme" })).body.items).toHaveLength(1);
    expect((await rpc(t, "runs/list")).body.items).toHaveLength(0);
  });

  test("an unknown project answers 404 everywhere", async () => {
    const t = setup();
    for (const [path, input] of [
      ["overview", { project: "nope" }],
      ["settings/get", { project: "nope" }],
      ["system", { project: "nope" }],
      ["logs/list", { project: "nope" }],
    ] as const) {
      expect((await rpc(t, path, input)).status).toBe(404);
    }
    expect((await rpc(t, "settings/get", { project: "Not A Slug" })).status).toBe(400);
  });
});

describe("runs.replay API", () => {
  const rpc = async (t: ReturnType<typeof setup>, path: string, input?: unknown) => {
    const res = await t.call(path, input, TOKEN);
    const body = (await res.json()) as { json: any };
    return { status: res.status, body: body.json };
  };
  const env = { SENTRY_CLIENT_SECRET: "s", GITHUB_TOKEN: "t", GITHUB_REPO: "acme/widgets" };
  const event = { project: "default", source: "sentry", kind: "event_alert", externalId: "evt-1", receivedAt: "2026-01-01T00:00:00.000Z", payload: { data: { event: { title: "boom" } }, token: "x" } };
  const seed = (
    t: ReturnType<typeof setup>,
    over: { status?: "running" | "succeeded" | "failed" | "duplicate"; automation?: string; source?: string; project?: string; withEvent?: boolean; outcome?: Record<string, unknown> } = {},
  ) => {
    const { status = "failed", automation = "sentry-to-github-issue", source = "sentry", project = "default", withEvent = true, outcome } = over;
    const run = { project, automation, source, kind: "k", externalId: "evt-1", startedAt: new Date().toISOString() };
    if (status === "duplicate") return t.activity.recordDuplicate(run);
    const id = t.activity.startRun({ ...run, ...(withEvent ? { event } : {}) });
    if (status !== "running") t.activity.finishRun(id, { status, ...(status === "failed" ? { error: "boom" } : {}), ...(outcome ? { outcome } : {}), finishedAt: new Date().toISOString() });
    return id;
  };
  const precondition = async (t: ReturnType<typeof setup>, id: string, message: string) => {
    const res = await rpc(t, "runs/replay", { id });
    expect(res.status).toBe(412);
    expect(res.body.message).toContain(message);
  };

  test("needs the admin token", async () => {
    expect((await setup().call("runs/replay", { id: "x" })).status).toBe(401);
  });

  test("a failed run is replayed as a new run linked to the original", async () => {
    const t = setup({ adminToken: TOKEN, env });
    const id = seed(t);
    const res = await rpc(t, "runs/replay", { id });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("started");
    const replayed = t.activity.getRun(res.body.runId);
    expect(replayed?.run).toMatchObject({ automation: "sentry-to-github-issue", project: "default", replayOf: id });
    expect(replayed?.event?.payload).toMatchObject({ token: "[redacted]" });
    await Bun.sleep(50);
  });

  test("a run that is running, succeeded or a duplicate is refused with a reason", async () => {
    const t = setup({ adminToken: TOKEN, env });
    await precondition(t, seed(t, { status: "running" }), "still running");
    await precondition(t, seed(t, { status: "succeeded" }), "Only failed runs");
    await precondition(t, seed(t, { status: "duplicate" }), "duplicate");
  });

  test("a run without a stored event is refused", async () => {
    const t = setup({ adminToken: TOKEN, env });
    await precondition(t, seed(t, { withEvent: false }), "no stored event");
  });

  test("an automation that is no longer configured is refused", async () => {
    const t = setup({ adminToken: TOKEN, env });
    await precondition(t, seed(t, { automation: "gone" }), "no longer configured");
  });

  test("a run of another project is not found", async () => {
    const t = setup({ adminToken: TOKEN, encryptionKey: "k", env });
    await rpc(t, "projects/create", { name: "Acme" });
    const id = seed(t, { project: "acme" });
    expect((await rpc(t, "runs/replay", { id })).status).toBe(404);
    expect((await rpc(t, "runs/replay", { project: "acme", id })).status).toBe(412);
    expect((await rpc(t, "runs/replay", { id: "nope" })).status).toBe(404);
  });

  test("a failed scheduled job is re-run by name without a stored event and linked to the original", async () => {
    const calls: string[] = [];
    const fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return Response.json({ results: [[1, 1, 1, 1, 1, 1]] });
    }) as typeof globalThis.fetch;
    const t = setup({ adminToken: TOKEN, encryptionKey: "k", githubFetch: fetch });
    await rpc(t, "settings/update", { integrationId: "posthog", values: { enabled: true, projectId: "77", personalApiKey: "phx_k", slackWebhookUrl: "https://hooks.slack.com/services/T/B/x" } });
    const id = seed(t, { automation: "posthog-weekly-report", source: "schedule", withEvent: false });
    const res = await rpc(t, "runs/replay", { id });
    expect(res.status).toBe(200);
    expect(t.activity.getRun(res.body.runId)?.run).toMatchObject({ automation: "posthog-weekly-report", source: "schedule", replayOf: id });
    expect(t.activity.getRun(res.body.runId)?.run.externalId).toMatch(/^replay:/);
    await Bun.sleep(50);
  });

  test("a dry replay of a succeeded run is allowed, is marked dry and links to the original", async () => {
    const t = setup({ adminToken: TOKEN, env });
    const id = seed(t, { status: "succeeded" });
    const res = await rpc(t, "runs/replay", { id, dryRun: true });
    expect(res.status).toBe(200);
    expect(t.activity.getRun(res.body.runId)?.run).toMatchObject({ replayOf: id, dryRun: true });
    await Bun.sleep(50);
  });

  test("a dry replay is still refused for running and duplicate runs, scheduled jobs and runs with no event", async () => {
    const t = setup({ adminToken: TOKEN, env });
    const dry = async (id: string, message: string) => {
      const res = await rpc(t, "runs/replay", { id, dryRun: true });
      expect(res.status).toBe(412);
      expect(res.body.message).toContain(message);
    };
    await dry(seed(t, { status: "running" }), "still running");
    await dry(seed(t, { status: "duplicate" }), "duplicate");
    await dry(seed(t, { withEvent: false }), "no stored event");
    await dry(seed(t, { automation: "posthog-weekly-report", source: "schedule", withEvent: false }), "Scheduled jobs cannot be dry-run");
  });

  test("a claim store failure is a 502 with a clear message, not a raw 500", async () => {
    const broken: ClaimStore = {
      claim() {
        throw new Error("database is locked");
      },
      complete() {},
      release() {},
      close() {},
    };
    const t = setup({ adminToken: TOKEN, env, claims: broken });
    const res = await rpc(t, "runs/replay", { id: seed(t) });
    expect(res.status).toBe(502);
    expect(res.body.message).toContain("claim store is unavailable");
    expect(JSON.stringify(res.body)).not.toContain("database is locked");
  });

  test("dry runs are left out of the crisp inbox and the runs list can filter them", async () => {
    const t = setup({ adminToken: TOKEN, env });
    const outcome = { decision: "issue" };
    const real = seed(t, { automation: "crisp-triage", source: "crisp", status: "succeeded", outcome });
    const dry = t.activity.startRun({ project: "default", automation: "crisp-triage", source: "crisp", kind: "k", externalId: "d", startedAt: new Date().toISOString(), dryRun: true });
    t.activity.finishRun(dry, { status: "succeeded", finishedAt: new Date().toISOString(), outcome });
    expect((await rpc(t, "crisp/list", {})).body.items.map((i: { id: string }) => i.id)).toEqual([real]);
    const ids = async (dryRun?: string) => (await rpc(t, "runs/list", dryRun ? { dryRun } : {})).body.items.map((r: { id: string }) => r.id).sort();
    expect(await ids()).toEqual([dry, real].sort());
    expect(await ids("exclude")).toEqual([real]);
    expect(await ids("only")).toEqual([dry]);
  });

  test("a scheduled job that is no longer enabled is refused", async () => {
    const t = setup({ adminToken: TOKEN, env });
    await precondition(t, seed(t, { automation: "posthog-weekly-report", source: "schedule", withEvent: false }), "no longer configured");
  });
});

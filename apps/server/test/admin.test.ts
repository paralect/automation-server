import { createDispatcher, createSqliteActivityStore, createSqliteStore, type Logger } from "@automation-server/core";
import { createSqliteSettingsStore, resolveConfig } from "@automation-server/settings";
import { describe, expect, test } from "bun:test";

import { createGithubActionsReader } from "@automation-server/api/githubActions";

import { createApp } from "../src/app";
import { webhookUrls } from "../src/config";
import { INTEGRATION_MODULES } from "../src/integrations/registry";
import { createRuntime } from "../src/runtime";

const TOKEN = "t".repeat(40);
const quiet: Logger = { info() {}, warn() {}, error() {} };

function setup(options: { adminToken?: string; encryptionKey?: string; env?: Record<string, string>; githubFetch?: typeof fetch } = { adminToken: TOKEN }) {
  const { adminToken, encryptionKey, env = {}, githubFetch } = options;
  const settings = createSqliteSettingsStore({ path: ":memory:", encryptionKey });
  const runtime = createRuntime({
    modules: INTEGRATION_MODULES,
    resolve: () => resolveConfig(settings, env),
    deps: { log: quiet, fetch: githubFetch },
  });
  const activity = createSqliteActivityStore({ path: ":memory:" });
  const dispatcher = createDispatcher({ automations: runtime.automations, store: createSqliteStore({ path: ":memory:" }), log: quiet });
  const app = createApp({
    sources: runtime.sources,
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
      adminToken,
      settings: { store: settings, env, reload: runtime.rebuild, test: runtime.test },
      system: () => ({
        startedAt: new Date().toISOString(),
        sources: Object.keys(runtime.sources()),
        automations: runtime.automations().map((a) => a.name),
        jobs: runtime.jobs().map((j) => j.name),
        retentionDays: 30,
        webhookUrls: webhookUrls(["sentry", "linear"], "https://hooks.example.com"),
      }),
    },
  });
  const call = (path: string, input: unknown, bearer?: string) =>
    app.request(`/rpc/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify({ json: input }),
    });
  return { activity, call, app, settings };
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
    t.activity.recordDuplicate({ automation: "a", source: "s", kind: "k", externalId: "e", startedAt: new Date().toISOString() });
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
    const id = t.activity.startRun({ automation: "a", source: "s", kind: "k", externalId: "e", startedAt: new Date().toISOString() });
    t.activity.recordLog({ time: new Date().toISOString(), level: "info", message: "hello", fields: { runId: id } });
    const res = await t.call("runs/get", { id }, TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json: { run: { id: string }; logs: { message: string }[] } };
    expect(body.json.run.id).toBe(id);
    expect(body.json.logs.map((l) => l.message)).toEqual(["hello"]);
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
      webhookUrls: { sentry: "https://hooks.example.com/webhooks/sentry" },
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

  test("testConnection reports a rejected token, an unconfigured integration and not-yet-available ones", async () => {
    const rejecting = (async (_url: string | URL | Request) => new Response("{}", { status: 401 })) as typeof fetch;
    const bad = setup({ adminToken: TOKEN, githubFetch: rejecting, env: { GITHUB_TOKEN: "x" } });
    expect((await rpc(bad, "settings/testConnection", { integrationId: "github" })).body).toMatchObject({ ok: false, available: true });

    const none = setup({ adminToken: TOKEN });
    expect((await rpc(none, "settings/testConnection", { integrationId: "github" })).body).toMatchObject({ ok: false, message: expect.stringContaining("not configured") });
    for (const integrationId of ["linear", "posthog", "sentry"]) {
      expect((await rpc(none, "settings/testConnection", { integrationId })).body).toMatchObject({ ok: false, available: false });
    }
  });
});

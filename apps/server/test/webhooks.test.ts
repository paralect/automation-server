import { createDispatcher, createSqliteActivityStore, createSqliteStore, type Logger } from "@automation-server/core";
import { createSqliteSettingsStore, envFor, resolveConfig } from "@automation-server/settings";
import { beforeEach, describe, expect, test } from "bun:test";
import { UNOBSERVED } from "@automation-server/ledger";
import { createSqliteLedger } from "@automation-server/ledger/server";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import { createGithubActionsReader } from "@automation-server/api/githubActions";
import { createWorkflowInstaller } from "@automation-server/api/workflowInstaller";

import { createApp } from "../src/app";
import { INTEGRATION_MODULES } from "../src/integrations/registry";
import { createRuntime } from "../src/runtime";

const SECRET = "test-client-secret";
const fixture = new Uint8Array(
  readFileSync(new URL("../../../packages/sources/test/fixtures/sentry-event-alert.json", import.meta.url)),
);
const sign = (body: Uint8Array, secret = SECRET) => createHmac("sha256", secret).update(body).digest("hex");

type GithubCall = { method: string; path: string };

function setup({ maxBodyBytes }: { maxBodyBytes?: number } = {}) {
  const calls: GithubCall[] = [];
  const logs: string[] = [];
  const failNextIssueCreate = { value: false };
  const gate = { current: Promise.resolve() as Promise<void> };

  const fakeGithub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname });
    await gate.current;
    if (url.pathname.endsWith("/issues") && method === "GET") return Response.json([]);
    if (url.pathname.endsWith("/labels")) return Response.json({}, { status: 201 });
    if (url.pathname.endsWith("/issues") && method === "POST") {
      if (failNextIssueCreate.value) {
        failNextIssueCreate.value = false;
        return new Response("boom", { status: 500 });
      }
      return Response.json({ number: 7, html_url: "https://github.test/acme/widgets/issues/7" }, { status: 201 });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  const log: Logger = {
    info: (m, f) => logs.push(JSON.stringify({ m, f })),
    warn: (m, f) => logs.push(JSON.stringify({ m, f })),
    error: (m, f) => logs.push(JSON.stringify({ m, f })),
  };
  const store = createSqliteStore({ path: ":memory:" });
  const settings = createSqliteSettingsStore({ path: ":memory:" });
  const env = {
    SENTRY_CLIENT_SECRET: SECRET,
    GITHUB_TOKEN: "gh-token",
    GITHUB_REPO: "acme/widgets",
    SENTRY_LEVELS: "error",
  };
  const runtime = createRuntime({ observerFor: () => UNOBSERVED,
    modules: INTEGRATION_MODULES,
    projects: () => settings.projects().map((p) => p.id), resolve: (p) => resolveConfig(settings.project(p), envFor(p, env)),
    deps: { log, fetch: fakeGithub },
  });
  const dispatcher = createDispatcher({ automations: runtime.automations, store, log });
  const admin = {
    activity: createSqliteActivityStore({ path: ":memory:" }),
    actions: () => createGithubActionsReader({ repos: [], token: "t", fetch: fakeGithub }),
    workflows: () => createWorkflowInstaller({ token: undefined }),
    adminToken: undefined,
    settings: { db: settings, env, reload: runtime.rebuild, test: runtime.test, health: () => ({}) },
    posthog: {
      preview: async () => ({ ok: false as const, message: "unused" }),
      runNow: async () => ({ status: "busy" as const, message: "unused" }),
    },
    replay: { event: async () => ({ outcome: "unknown-automation" as const }), job: async () => ({ status: "unknown-job" as const }) },
    ledger: createSqliteLedger({ path: ":memory:" }),
    outcomes: { syncNow: async () => ({ status: "not-configured" as const, message: "unused" }) },
    slackDirectory: { list: async () => ({ items: [], truncated: false }) },
    system: () => ({
      startedAt: new Date().toISOString(),
      sources: Object.keys(runtime.sources("default")),
      automations: [],
      jobs: [],
      retentionDays: 30,
      webhookUrls: {},
    }),
  };
  const app = createApp({ source: runtime.source, defaultProject: "default", dispatcher, log, maxBodyBytes, admin });

  const post = (path: string, body: Uint8Array, headers: Record<string, string> = {}) =>
    app.request(path, { method: "POST", body, headers });
  const deliver = (body = fixture, headers: Record<string, string> = {}) =>
    post("/webhooks/sentry", body, {
      "sentry-hook-resource": "event_alert",
      "sentry-hook-signature": sign(body),
      ...headers,
    });
  const issueCreates = () => calls.filter((c) => c.method === "POST" && c.path.endsWith("/issues")).length;

  return { app, dispatcher, calls, logs, deliver, post, issueCreates, failNextIssueCreate, gate, settings, runtime };
}

let t: ReturnType<typeof setup>;
beforeEach(() => {
  t = setup();
});

describe("POST /webhooks/:source", () => {
  test("valid signed alert responds 200 before GitHub work finishes, then creates exactly one issue", async () => {
    let release!: () => void;
    t.gate.current = new Promise<void>((r) => (release = r));
    const res = await t.deliver();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(t.issueCreates()).toBe(0);
    release();
    await t.dispatcher.drain(2000);
    expect(t.issueCreates()).toBe(1);
  });

  test("redelivery of the same payload creates one issue", async () => {
    await t.deliver();
    await t.dispatcher.drain(2000);
    await t.deliver();
    await t.dispatcher.drain(2000);
    expect(t.issueCreates()).toBe(1);
  });

  test("a GitHub 500 releases the claim so a redelivery succeeds", async () => {
    t.failNextIssueCreate.value = true;
    await t.deliver();
    await t.dispatcher.drain(2000);
    expect(t.issueCreates()).toBe(1);
    await t.deliver();
    await t.dispatcher.drain(2000);
    expect(t.issueCreates()).toBe(2);
    await t.deliver();
    await t.dispatcher.drain(2000);
    expect(t.issueCreates()).toBe(2);
  });

  test("wrong signature gives 401 with an empty body and no GitHub calls", async () => {
    const res = await t.deliver(fixture, { "sentry-hook-signature": sign(fixture, "other-secret") });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
    await t.dispatcher.drain(500);
    expect(t.calls).toHaveLength(0);
    expect(t.logs.join("\n")).not.toContain("other-secret");
  });

  test("missing signature gives 401", async () => {
    const res = await t.post("/webhooks/sentry", fixture, { "sentry-hook-resource": "event_alert" });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
    expect(t.calls).toHaveLength(0);
  });

  test("tampered body gives 401", async () => {
    const tampered = new Uint8Array([...fixture, 0x20]);
    const res = await t.post("/webhooks/sentry", tampered, {
      "sentry-hook-resource": "event_alert",
      "sentry-hook-signature": sign(fixture),
    });
    expect(res.status).toBe(401);
    expect(t.calls).toHaveLength(0);
  });

  test("unsupported resource with a valid signature is acknowledged and ignored", async () => {
    const res = await t.deliver(fixture, { "sentry-hook-resource": "installation" });
    expect(res.status).toBe(200);
    await t.dispatcher.drain(500);
    expect(t.calls).toHaveLength(0);
    expect(t.logs.some((l) => l.includes("unsupported_resource:installation"))).toBe(true);
  });

  test("body over the cap gives 413 by content-length", async () => {
    const small = setup({ maxBodyBytes: 100 });
    const res = await small.deliver();
    expect(res.status).toBe(413);
    expect(small.calls).toHaveLength(0);
  });

  test("body over the cap gives 413 while streaming without a content-length", async () => {
    const small = setup({ maxBodyBytes: 100 });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(60));
        controller.enqueue(new Uint8Array(60));
        controller.close();
      },
    });
    const res = await small.app.request("/webhooks/sentry", {
      method: "POST",
      body: stream,
      duplex: "half",
      headers: { "sentry-hook-resource": "event_alert" },
    } as RequestInit);
    expect(res.status).toBe(413);
  });

  test("unknown source gives 404", async () => {
    const res = await t.post("/webhooks/nope", fixture);
    expect(res.status).toBe(404);
  });

  test("inherited object keys are not sources", async () => {
    const res = await t.post("/webhooks/constructor", fixture);
    expect(res.status).toBe(404);
  });

  test("a verified delivery logs webhook received with identity only", async () => {
    await t.deliver();
    await t.dispatcher.drain(2000);
    const received = t.logs.map((l) => JSON.parse(l)).find((l) => l.m === "webhook received");
    expect(received.f).toMatchObject({ project: "default", source: "sentry", kind: "issue_alert", externalId: "1117540176" });
    expect(Object.keys(received.f).sort()).toEqual(["externalId", "kind", "project", "source"]);
  });

  test("logs never contain the GitHub token", async () => {
    await t.deliver();
    await t.dispatcher.drain(2000);
    expect(t.logs.join("\n")).not.toContain("gh-token");
  });
});

describe("GET /health", () => {
  test("returns ok", async () => {
    const res = await t.app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("POST /webhooks/:project/:source", () => {
  const deliverTo = (path: string, secret: string) =>
    t.post(path, fixture, { "sentry-hook-resource": "event_alert", "sentry-hook-signature": sign(fixture, secret) });

  test("the legacy URL and the project URL both reach the default project", async () => {
    expect((await deliverTo("/webhooks/default/sentry", SECRET)).status).toBe(200);
    await t.dispatcher.drain(2000);
    expect(t.issueCreates()).toBe(1);
    expect((await deliverTo("/webhooks/sentry", SECRET)).status).toBe(200);
    await t.dispatcher.drain(2000);
    expect(t.issueCreates()).toBe(1);
  });

  test("another project verifies with its own secret and does not share claims with the default project", async () => {
    const acme = t.settings.createProject({ name: "Acme" });
    t.settings.project(acme.id).apply({
      set: [
        { key: "sentry.clientSecret", json: JSON.stringify("acme-secret"), secret: false },
        { key: "github.token", json: JSON.stringify("acme-token"), secret: false },
        { key: "github.repo", json: JSON.stringify("acme/app"), secret: false },
      ],
    });
    t.runtime.rebuild();

    expect((await deliverTo("/webhooks/acme/sentry", SECRET)).status).toBe(401);
    expect((await deliverTo("/webhooks/acme/sentry", "acme-secret")).status).toBe(200);
    await t.dispatcher.drain(2000);
    expect((await deliverTo("/webhooks/sentry", SECRET)).status).toBe(200);
    await t.dispatcher.drain(2000);
    expect(t.calls.filter((c) => c.method === "POST" && c.path.endsWith("/issues")).map((c) => c.path)).toEqual([
      "/repos/acme/app/issues",
      "/repos/acme/widgets/issues",
    ]);
  });

  test("an unknown project or a project without the source answers 404", async () => {
    expect((await deliverTo("/webhooks/nope/sentry", SECRET)).status).toBe(404);
    t.settings.createProject({ name: "Empty" });
    t.runtime.rebuild();
    expect((await deliverTo("/webhooks/empty/sentry", SECRET)).status).toBe(404);
  });
});

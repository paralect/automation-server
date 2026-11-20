import { createDispatcher, createSqliteActivityStore, createSqliteStore, type Logger } from "@automation-server/core";
import { createSqliteSettingsStore, envFor, resolveConfig } from "@automation-server/settings";
import { describe, expect, test } from "bun:test";
import { UNOBSERVED } from "@automation-server/ledger";
import { createHmac } from "node:crypto";

import { createWebhookRoutes } from "../src/webhooks";
import { INTEGRATION_MODULES } from "../src/integrations/registry";
import { createRuntime } from "../src/runtime";

const SECRET = "crisp_signing_secret";
const WEBSITE = "site-1";
const SESSION = "session_1";
const PLUGIN_KEY = "crisp_plugin_key_value";
const OR_KEY = "sk-or-v1-test-key";
const CUSTOMER_TEXT = "The export button on reports does nothing for me";

type Call = { method: string; url: URL; body: unknown };

const verdict = {
  category: "bug",
  confidence: 0.9,
  severity: "minor",
  area: "unknown",
  summary: "Export button does nothing on the reports page.",
  repro: { steps: ["Open reports", "Click Export"], expected: "A file downloads", actual: "Nothing happens" },
  missing: [],
  evidence: ["export button on reports does nothing"],
  answerDraft: null,
};

function setup(values: { openrouter?: boolean; mode?: string; github?: boolean } = {}) {
  const { openrouter = true, mode, github = false } = values;
  const calls: Call[] = [];
  const logs: string[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const ok = (data: unknown) => Response.json({ error: false, reason: "resolved", data });
    if (url.host === "api.crisp.chat") {
      if (url.pathname.endsWith("/messages")) {
        return ok([{ type: "text", from: "user", content: CUSTOMER_TEXT, timestamp: Date.now() - 1000 }]);
      }
      if (method === "GET" && url.pathname.endsWith(`/conversation/${SESSION}`)) return ok({ meta: { email: "c@example.com", segments: ["triage"] } });
      if (method === "GET") return ok({ name: "Acme" });
      return ok({});
    }
    if (url.host === "openrouter.ai") {
      if (url.pathname.endsWith("/key")) return Response.json({ data: { label: "prod", limit: null, usage: 0 } });
      return Response.json({ choices: [{ message: { content: JSON.stringify(verdict) } }] });
    }
    if (url.host === "api.github.com" && method === "GET") return Response.json([]);
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  const record = (m: string, f?: Record<string, unknown>) => logs.push(JSON.stringify({ m, f }));
  const log: Logger = { info: record, warn: record, error: record };

  const settings = createSqliteSettingsStore({ path: ":memory:", encryptionKey: "k" });
  const set = (key: string, value: unknown, secret = false) => ({ key, json: JSON.stringify(value), secret });
  settings.apply({
    set: [
      set("crisp.websiteId", WEBSITE),
      set("crisp.pluginIdentifier", "plugin-id"),
      set("crisp.pluginKey", PLUGIN_KEY, true),
      set("crisp.webhookSecret", SECRET, true),
      ...(mode ? [set("crisp.mode", mode)] : []),
      ...(openrouter ? [set("openrouter.apiKey", OR_KEY, true)] : []),
      ...(github ? [set("github.token", "ghp_x", true), set("github.repo", "acme/app")] : []),
    ],
  });
  const runtime = createRuntime({ observerFor: () => UNOBSERVED,
    modules: INTEGRATION_MODULES,
    projects: () => settings.projects().map((p) => p.id),
    resolve: (p) => resolveConfig(settings.project(p), envFor(p, {})),
    deps: { log, fetch: fake },
  });
  const activity = createSqliteActivityStore({ path: ":memory:" });
  const dispatcher = createDispatcher({
    automations: runtime.automations,
    store: createSqliteStore({ path: ":memory:" }),
    log,
    activity,
    prepare: (event) => runtime.source(event.project ?? "default", event.source)?.enrich?.(event) ?? Promise.resolve(event),
  });
  const app = createWebhookRoutes({ source: runtime.source, defaultProject: "default", dispatcher, log });

  const deliver = (segments = ["triage"]) => {
    const timestamp = String(Date.now());
    const raw = JSON.stringify({
      website_id: WEBSITE,
      event: "session:set_segments",
      data: { website_id: WEBSITE, session_id: SESSION, inbox_id: null, segments },
      timestamp: Number(timestamp),
    });
    const signature = createHmac("sha256", SECRET).update(`[${timestamp};${raw}]`).digest("hex");
    return app.request("/webhooks/default/crisp", {
      method: "POST",
      body: raw,
      headers: { "x-crisp-request-timestamp": timestamp, "x-crisp-signature": signature },
    });
  };
  return { runtime, dispatcher, activity, calls, logs, deliver, app };
}

describe("crisp integration", () => {
  test("an unsigned delivery is rejected", async () => {
    const t = setup();
    expect((await t.app.request("/webhooks/default/crisp", { method: "POST", body: "{}" })).status).toBe(401);
  });

  test("without OpenRouter the webhook is served but nothing is triaged", async () => {
    const t = setup({ openrouter: false });
    expect((await t.deliver()).status).toBe(200);
    await t.dispatcher.drain(2000);
    expect(t.runtime.automations()).toHaveLength(0);
  });

  test("issue mode without a GitHub repository registers no automation", () => {
    const t = setup({ mode: "issue" });
    expect(t.runtime.automations()).toHaveLength(0);
    expect(t.logs.some((l) => l.includes("needs the GitHub token and issues repository"))).toBe(true);
  });

  test("a signed segment delivery in shadow mode posts one note and a status segment, and a redelivery is a duplicate", async () => {
    const t = setup();
    expect((await t.deliver()).status).toBe(200);
    await t.dispatcher.drain(2000);
    const writes = () => t.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url.host}${c.url.pathname}`);
    expect(writes()).toEqual([
      "POST openrouter.ai/api/v1/chat/completions",
      "POST openrouter.ai/api/v1/chat/completions",
      `POST api.crisp.chat/v1/website/${WEBSITE}/conversation/${SESSION}/message`,
      `PATCH api.crisp.chat/v1/website/${WEBSITE}/conversation/${SESSION}/meta`,
    ]);
    expect(t.calls.at(-1)?.body).toEqual({ segments: ["triage", "triage:issue"] });
    expect(t.activity.queryRuns({ limit: 10 }).items[0]).toMatchObject({ automation: "crisp-triage", status: "succeeded" });

    await t.deliver();
    await t.dispatcher.drain(2000);
    expect(writes()).toHaveLength(4);

    const logged = t.logs.join("\n");
    expect(logged).toContain('"category":"bug"');
    expect(logged).not.toContain(CUSTOMER_TEXT);
    expect(logged).not.toContain("c@example.com");
    expect(logged).not.toContain(PLUGIN_KEY);
    expect(logged).not.toContain(OR_KEY);
  });

  test("dry-run mode marks live runs as dry, reads, and writes nothing to Crisp or GitHub", async () => {
    const t = setup({ mode: "dry-run", github: true });
    expect((await t.deliver()).status).toBe(200);
    await t.dispatcher.drain(2000);
    const writes = t.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url.host}`);
    expect(new Set(writes)).toEqual(new Set(["POST openrouter.ai"]));
    const run = t.activity.queryRuns({ limit: 10 }).items[0];
    expect(run).toMatchObject({ automation: "crisp-triage", status: "succeeded", dryRun: true });
    expect(run?.outcome).toMatchObject({ dryRun: true, decision: "issue", wouldDo: { issue: { labels: expect.arrayContaining(["crisp", "bug"]) } } });
    expect(t.activity.stats("2000-01-01T00:00:00.000Z", 3_600_000).runs.succeeded).toBe(0);
  });

  test("dry-run mode without a GitHub repository registers no automation", () => {
    expect(setup({ mode: "dry-run" }).runtime.automations()).toHaveLength(0);
  });

  test("the connection tests reach Crisp and OpenRouter", async () => {
    const t = setup();
    expect(await t.runtime.test("default", "crisp")).toMatchObject({ ok: true, message: expect.stringContaining("Plugin token can read website Acme") });
    expect(await t.runtime.test("default", "openrouter")).toMatchObject({ ok: true, message: "OpenRouter accepted the key prod" });
  });
});

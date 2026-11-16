import { describe, expect, test } from "bun:test";

import { effectiveActionsRepos, parseCsv, parseRepo, resolveConfig } from "../src/resolve";
import { createSqliteSettingsStore } from "../src/store";
import { describeSettings, planUpdate, SettingsInputError } from "../src/update";

const fresh = () => createSqliteSettingsStore({ path: ":memory:", encryptionKey: "k" });

describe("resolution order", () => {
  test("db beats env beats default, and origin says which", () => {
    const store = fresh();
    store.apply({ set: [{ key: "sentry.minEventCount", json: "9", secret: false }] });
    const env = { SENTRY_MIN_EVENT_COUNT: "5", SENTRY_API_BASE_URL: "https://sentry.example" };
    const { sentry } = resolveConfig(store, env);
    expect(sentry.values.minEventCount).toBe(9);
    expect(sentry.values.apiBaseUrl).toBe("https://sentry.example");
    expect(sentry.values.levels).toEqual(["error", "fatal"]);
    expect(sentry.origin).toMatchObject({ minEventCount: "db", apiBaseUrl: "env", levels: "default", authToken: "unset" });
  });

  test("an env-only deployment resolves exactly as before", () => {
    const env = {
      GITHUB_TOKEN: "gh",
      GITHUB_REPO: "acme/widgets",
      SENTRY_CLIENT_SECRET: "s",
      SENTRY_LEVELS: "error, fatal",
      SENTRY_ENVIRONMENTS: "production, staging",
      SENTRY_MIN_EVENT_COUNT: "5",
      SENTRY_AUTH_TOKEN: "",
    };
    const cfg = resolveConfig(fresh(), env);
    expect(cfg.github.configured).toBe(true);
    expect(cfg.github.values).toEqual({ token: "gh", repo: "acme/widgets" });
    expect(cfg.sentry.configured).toBe(true);
    expect(cfg.sentry.values).toEqual({
      clientSecret: "s",
      apiBaseUrl: "https://sentry.io",
      levels: ["error", "fatal"],
      environments: ["production", "staging"],
      minEventCount: 5,
    });
    expect(effectiveActionsRepos(cfg.github)).toEqual(["acme/widgets"]);
  });

  test("an empty env var counts as unset", () => {
    const cfg = resolveConfig(fresh(), { GITHUB_TOKEN: "", SENTRY_CLIENT_SECRET: "" });
    expect(cfg.github.configured).toBe(false);
    expect(cfg.github.missing).toEqual(["token"]);
    expect(cfg.sentry.missing).toEqual(["clientSecret"]);
  });

  test("a missing required field leaves the integration unconfigured", () => {
    const cfg = resolveConfig(fresh(), {});
    expect(cfg.linear.configured).toBe(false);
    expect(cfg.linear.missing).toEqual(["webhookSecret", "triggerLabel", "targetRepo"]);
    expect(cfg.posthog.missing).toEqual(["projectId", "personalApiKey", "slackWebhookUrl"]);
    expect(cfg.posthog.values.host).toBe("https://us.posthog.com");
  });

  test("a db secret makes an integration configured", () => {
    const store = fresh();
    store.apply({ set: [{ key: "sentry.clientSecret", json: '"abc"', secret: true }] });
    const { sentry } = resolveConfig(store, {});
    expect(sentry.configured).toBe(true);
    expect(sentry.configured && sentry.values.clientSecret).toBe("abc");
  });

  test("an unreadable db secret falls back to env", () => {
    const writer = createSqliteSettingsStore({ path: ":memory:", encryptionKey: "k" });
    writer.apply({ set: [{ key: "github.token", json: '"x"', secret: true }] });
    const stored = writer.all();
    const cfg = resolveConfig({ all: () => ({ "github.token": { ...stored["github.token"]!, json: null } }) }, { GITHUB_TOKEN: "env-token" });
    expect(cfg.github.values.token).toBe("env-token");
    expect(cfg.github.origin.token).toBe("env");
  });

  test("a wrongly typed db value is ignored", () => {
    const cfg = resolveConfig({ all: () => ({ "sentry.minEventCount": { secret: false, json: '"nope"' } }) }, {});
    expect(cfg.sentry.values.minEventCount).toBe(1);
  });

  test("actions repos fall back to the issues repository, dedupe and validate", () => {
    const store = fresh();
    store.apply({ set: [{ key: "github.actionsRepos", json: '["acme/site","acme/site"]', secret: false }] });
    expect(effectiveActionsRepos(resolveConfig(store, { GITHUB_REPO: "acme/widgets" }).github)).toEqual(["acme/site"]);
    expect(effectiveActionsRepos(resolveConfig(fresh(), {}).github)).toEqual([]);
  });
});

describe("parsers", () => {
  test("parseCsv trims and drops empties", () => {
    expect(parseCsv(" error , fatal,, ")).toEqual(["error", "fatal"]);
    expect(parseCsv(undefined)).toEqual([]);
  });
  test("parseRepo", () => {
    expect(parseRepo("acme/widgets")).toEqual({ owner: "acme", name: "widgets" });
    for (const bad of ["acme", "acme/", "/widgets", "a/b/c", ""]) expect(() => parseRepo(bad)).toThrow("owner/name");
  });
});

describe("planUpdate", () => {
  test("stores secrets only for non-empty strings", () => {
    const plan = planUpdate("sentry", { values: { clientSecret: "abc", authToken: "", apiBaseUrl: "https://s.example" } });
    expect(plan.set).toEqual([
      { key: "sentry.clientSecret", json: '"abc"', secret: true },
      { key: "sentry.apiBaseUrl", json: '"https://s.example"', secret: false },
    ]);
    expect(plan.remove).toEqual([]);
  });

  test("clear removes keys and wins over a value in the same request", () => {
    const plan = planUpdate("sentry", { values: { authToken: "x", levels: ["error"] }, clear: ["authToken"] });
    expect(plan.remove).toEqual(["sentry.authToken"]);
    expect(plan.set.map((w) => w.key)).toEqual(["sentry.levels"]);
  });

  test("rejects unknown fields, wrong types, bounds and bad repos", () => {
    expect(() => planUpdate("sentry", { values: { nope: 1 } })).toThrow(SettingsInputError);
    expect(() => planUpdate("sentry", { values: { minEventCount: "5" } })).toThrow(SettingsInputError);
    expect(() => planUpdate("posthog", { values: { dayOfWeek: 7 } })).toThrow(SettingsInputError);
    expect(() => planUpdate("posthog", { values: { hourUtc: -1 } })).toThrow(SettingsInputError);
    expect(() => planUpdate("linear", { values: { targetRepo: "not a repo" } })).toThrow(SettingsInputError);
    expect(() => planUpdate("github", { values: { actionsRepos: ["acme"] } })).toThrow(SettingsInputError);
    expect(() => planUpdate("sentry", { clear: ["bogus"] })).toThrow(SettingsInputError);
  });

  test("a fractional number between its bounds is accepted, one outside is not", () => {
    expect(planUpdate("crisp", { values: { minConfidence: 0.65 } }).set).toEqual([{ key: "crisp.minConfidence", json: "0.65", secret: false }]);
    expect(() => planUpdate("crisp", { values: { minConfidence: 1.5 } })).toThrow(SettingsInputError);
    expect(() => planUpdate("crisp", { values: { mode: "yolo" } })).toThrow(SettingsInputError);
  });

  test("accepts valid typed values", () => {
    const plan = planUpdate("posthog", { values: { dayOfWeek: 3, hourUtc: 14, enabled: true, projectId: " 42 " } });
    expect(plan.set.map((w) => [w.key, w.json])).toEqual([
      ["posthog.projectId", '"42"'],
      ["posthog.enabled", "true"],
      ["posthog.dayOfWeek", "3"],
      ["posthog.hourUtc", "14"],
    ]);
  });
});

describe("describeSettings", () => {
  test("never exposes a secret value, only whether it is set and where from", () => {
    const store = fresh();
    store.apply({ set: [{ key: "sentry.clientSecret", json: '"db-secret"', secret: true }] });
    const env = { SENTRY_AUTH_TOKEN: "env-token", GITHUB_REPO: "acme/widgets" };
    const view = describeSettings(store, env, resolveConfig(store, env));
    expect(JSON.stringify(view)).not.toContain("db-secret");
    expect(JSON.stringify(view)).not.toContain("env-token");
    const sentry = view.integrations.find((i) => i.id === "sentry")!;
    expect(sentry.configured).toBe(true);
    expect(sentry.fields.find((f) => f.key === "clientSecret")).toMatchObject({ set: true, source: "db" });
    expect(sentry.fields.find((f) => f.key === "clientSecret")).not.toHaveProperty("value");
    expect(sentry.fields.find((f) => f.key === "authToken")).toMatchObject({ set: true, source: "env" });
    expect(view.integrations.find((i) => i.id === "github")!.fields.find((f) => f.key === "repo")).toMatchObject({
      value: "acme/widgets",
      source: "env",
    });
    expect(view.secretsWritable).toBe(true);
  });
});

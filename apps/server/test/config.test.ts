import { describe, expect, test } from "bun:test";

import { buildConfig, parseCsv, parseRepo, type RawEnv } from "../src/config";

const base: RawEnv = {
  PORT: 3000,
  DATABASE_PATH: "./data/automation.db",
  SENTRY_CLIENT_SECRET: "secret",
  SENTRY_API_BASE_URL: "https://sentry.io",
  SENTRY_LEVELS: "error,fatal",
  SENTRY_MIN_EVENT_COUNT: 1,
  GITHUB_TOKEN: "token",
  GITHUB_REPO: "acme/widgets",
  LOG_RETENTION_DAYS: 30,
};

describe("parseCsv", () => {
  test("trims and drops empty entries", () => {
    expect(parseCsv(" error , fatal,, ")).toEqual(["error", "fatal"]);
  });
  test("undefined and empty are empty lists", () => {
    expect(parseCsv(undefined)).toEqual([]);
    expect(parseCsv("")).toEqual([]);
  });
});

describe("parseRepo", () => {
  test("splits owner and name", () => {
    expect(parseRepo("acme/widgets")).toEqual({ owner: "acme", name: "widgets" });
  });
  test.each(["acme", "acme/", "/widgets", "a/b/c", ""])("rejects %p", (value) => {
    expect(() => parseRepo(value)).toThrow("owner/name");
  });
});

describe("buildConfig", () => {
  test("maps env to typed config", () => {
    expect(buildConfig(base)).toEqual({
      port: 3000,
      databasePath: "./data/automation.db",
      sentry: { clientSecret: "secret", authToken: undefined, apiBaseUrl: "https://sentry.io" },
      adminToken: undefined,
      retentionDays: 30,
      github: { token: "token", repo: { owner: "acme", name: "widgets" }, actionsRepos: ["acme/widgets"] },
      filters: { levels: ["error", "fatal"], environments: [], minEventCount: 1 },
    });
  });

  test("parses optional values", () => {
    const config = buildConfig({
      ...base,
      SENTRY_AUTH_TOKEN: "sntrys_x",
      SENTRY_ENVIRONMENTS: "production, staging",
      SENTRY_MIN_EVENT_COUNT: 5,
    });
    expect(config.sentry.authToken).toBe("sntrys_x");
    expect(config.filters.environments).toEqual(["production", "staging"]);
    expect(config.filters.minEventCount).toBe(5);
  });

  test("empty admin token counts as absent", () => {
    expect(buildConfig({ ...base, ADMIN_API_TOKEN: "" }).adminToken).toBeUndefined();
    expect(buildConfig({ ...base, ADMIN_API_TOKEN: "x".repeat(32) }).adminToken).toBe("x".repeat(32));
  });

  test("actions repos default to GITHUB_REPO and dedupe", () => {
    expect(buildConfig({ ...base, GITHUB_ACTIONS_REPOS: "" }).github.actionsRepos).toEqual(["acme/widgets"]);
    expect(buildConfig({ ...base, GITHUB_ACTIONS_REPOS: " acme/site, acme/widgets ,acme/site" }).github.actionsRepos).toEqual([
      "acme/site",
      "acme/widgets",
    ]);
    expect(() => buildConfig({ ...base, GITHUB_ACTIONS_REPOS: "acme" })).toThrow("owner/name");
  });

  test("empty auth token counts as absent", () => {
    expect(buildConfig({ ...base, SENTRY_AUTH_TOKEN: "" }).sentry.authToken).toBeUndefined();
  });
});

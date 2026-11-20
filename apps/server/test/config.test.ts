import { describe, expect, test } from "bun:test";

import { buildConfig, webhookUrls, type RawEnv } from "../src/config";

const base: RawEnv = { PORT: 3000, DATABASE_PATH: "./data/automation.db", LOG_RETENTION_DAYS: 30, LEDGER_RETENTION_DAYS: 400 };

describe("buildConfig", () => {
  test("maps env to typed config", () => {
    expect(buildConfig(base)).toEqual({
      port: 3000,
      databasePath: "./data/automation.db",
      adminToken: undefined,
      retentionDays: 30,
      ledgerRetentionDays: 400,
      encryptionKey: undefined,
      publicUrl: undefined,
    });
  });

  test("empty optional values count as absent", () => {
    const config = buildConfig({ ...base, ADMIN_API_TOKEN: "", SETTINGS_ENCRYPTION_KEY: "", PUBLIC_URL: "" });
    expect(config.adminToken).toBeUndefined();
    expect(config.encryptionKey).toBeUndefined();
    expect(config.publicUrl).toBeUndefined();
    expect(buildConfig({ ...base, ADMIN_API_TOKEN: "x".repeat(32) }).adminToken).toBe("x".repeat(32));
  });

  test("admin public url loses its trailing slash and empty counts as absent", () => {
    expect(buildConfig({ ...base, ADMIN_PUBLIC_URL: "https://admin.example.com/" }).adminPublicUrl).toBe("https://admin.example.com");
    expect(buildConfig({ ...base, ADMIN_PUBLIC_URL: "" }).adminPublicUrl).toBeUndefined();
  });

  test("public url loses its trailing slash", () => {
    expect(buildConfig({ ...base, PUBLIC_URL: "https://hooks.example.com/" }).publicUrl).toBe("https://hooks.example.com");
  });
});

describe("webhookUrls", () => {
  test("is relative without a public url and absolute with one", () => {
    expect(webhookUrls("default", ["sentry"], undefined)).toEqual({ sentry: "/webhooks/default/sentry" });
    expect(webhookUrls("acme", ["sentry", "linear"], "https://hooks.example.com")).toEqual({
      sentry: "https://hooks.example.com/webhooks/acme/sentry",
      linear: "https://hooks.example.com/webhooks/acme/linear",
    });
  });
});

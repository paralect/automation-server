import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSqliteHealthStore, parseExpiry } from "../src/health";
import { resolveConfig } from "../src/resolve";
import { createSqliteSettingsStore } from "../src/store";
import { describeSettings } from "../src/update";

const dirs: string[] = [];
const tempDb = () => {
  const dir = mkdtempSync(join(tmpdir(), "health-"));
  dirs.push(dir);
  return join(dir, "db.sqlite");
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const T0 = new Date("2026-11-17T06:00:00Z");

describe("health store", () => {
  test("put then get round-trips per project and integration", () => {
    const store = createSqliteHealthStore({ path: ":memory:" });
    store.put("acme", "github", { ok: true, message: "fine", expiresAt: "2026-12-01T10:00:00Z" }, T0);
    store.put("acme", "sentry", { ok: false, message: "rejected" }, T0);
    store.put("other", "github", { ok: true, message: "other" }, T0);
    expect(store.get("acme")).toEqual({
      github: { checkedAt: T0.toISOString(), ok: true, message: "fine", expiresAt: "2026-12-01T10:00:00.000Z" },
      sentry: { checkedAt: T0.toISOString(), ok: false, message: "rejected" },
    });
    expect(Object.keys(store.get("other"))).toEqual(["github"]);
    expect(store.get("none")).toEqual({});
  });

  test("an invalid expiresAt is dropped and a later put replaces the result but keeps the alert marker", () => {
    const store = createSqliteHealthStore({ path: ":memory:" });
    expect(store.put("p", "github", { ok: true, message: "m", expiresAt: "soon" }, T0).expiresAt).toBeUndefined();
    store.put("p", "github", { ok: true, message: "m", expiresAt: "2026-12-01T00:00:00Z" }, T0);
    store.markExpiryAlerted("p", "github", "2026-12-01T00:00:00.000Z");
    const next = store.put("p", "github", { ok: false, message: "later" }, new Date(T0.getTime() + 1000));
    expect(next).toEqual({
      checkedAt: "2026-11-17T06:00:01.000Z",
      ok: false,
      message: "later",
      alertedExpiry: "2026-12-01T00:00:00.000Z",
    });
  });

  test("parseExpiry normalizes dates and rejects non-dates", () => {
    expect(parseExpiry("2026-12-01 10:00:00 UTC")).toBe("2026-12-01T10:00:00.000Z");
    expect(parseExpiry("garbage")).toBeUndefined();
    expect(parseExpiry(5)).toBeUndefined();
  });

  test("migrates an existing database file that already has settings and activity tables, and keeps them", () => {
    const path = tempDb();
    const settings = createSqliteSettingsStore({ path, encryptionKey: "k" });
    settings.apply({ set: [{ key: "sentry.minEventCount", json: "4", secret: false }] });
    settings.close();
    const before = new Database(path);
    expect(before.query("SELECT 1 FROM sqlite_master WHERE name = 'integration_health'").get()).toBeNull();
    before.close();

    const health = createSqliteHealthStore({ path });
    health.put("default", "github", { ok: true, message: "ok" }, T0);
    health.close();

    const reopened = createSqliteHealthStore({ path });
    expect(reopened.get("default").github?.ok).toBe(true);
    reopened.close();
    const db = new Database(path);
    expect(db.query<{ version: number }, []>("SELECT version FROM schema_versions WHERE component = 'health'").get()?.version).toBe(1);
    db.close();
    const again = createSqliteSettingsStore({ path, encryptionKey: "k" });
    expect(again.project("default").all()["sentry.minEventCount"]?.json).toBe("4");
    again.close();
  });
});

describe("describeSettings health", () => {
  test("attaches health only to configured integrations", () => {
    const store = createSqliteSettingsStore({ path: ":memory:", encryptionKey: "k" });
    const env = { GITHUB_TOKEN: "t" };
    const health = {
      github: { checkedAt: "c", ok: true, message: "m", expiresAt: "2026-12-01T00:00:00.000Z", alertedExpiry: "x" },
      sentry: { checkedAt: "c", ok: false, message: "stale" },
    };
    const view = describeSettings(store, env, resolveConfig(store, env), health);
    const by = (id: string) => view.integrations.find((i) => i.id === id)!;
    expect(by("github").health).toEqual({ checkedAt: "c", ok: true, message: "m", expiresAt: "2026-12-01T00:00:00.000Z" });
    expect(by("sentry").health).toBeUndefined();
  });
});

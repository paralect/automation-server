import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSqliteActivityStore, createSqliteStore } from "@automation-server/core";

import { createSecretBox } from "../src/crypto";
import { DEFAULT_PROJECT_ID, ProjectInputError } from "../src/projects";
import { createSqliteSettingsStore, SecretsUnavailableError } from "../src/store";

const dirs: string[] = [];
const tempDb = () => {
  const dir = mkdtempSync(join(tmpdir(), "settings-"));
  dirs.push(dir);
  return join(dir, "db.sqlite");
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("secret box", () => {
  test("round-trips and uses a fresh iv per seal", () => {
    const box = createSecretBox("passphrase");
    const a = box.seal("hunter2");
    expect(a).not.toContain("hunter2");
    expect(box.seal("hunter2")).not.toBe(a);
    expect(box.open(a)).toBe("hunter2");
  });

  test("a different key, a tampered value and a plain value all open to null", () => {
    const sealed = createSecretBox("one").seal("hunter2");
    expect(createSecretBox("two").open(sealed)).toBeNull();
    const flipped = sealed.slice(0, -3) + (sealed.endsWith("AAA") ? "BBB" : "AAA");
    expect(createSecretBox("one").open(flipped)).toBeNull();
    expect(createSecretBox("one").open("plain")).toBeNull();
  });
});

describe("settings store", () => {
  test("plain settings work without an encryption key", () => {
    const store = createSqliteSettingsStore({ path: ":memory:" });
    store.apply({ set: [{ key: "sentry.levels", json: '["error"]', secret: false }] });
    expect(store.all()["sentry.levels"]).toEqual({ secret: false, json: '["error"]' });
    expect(store.canStoreSecrets).toBe(false);
  });

  test("writing a secret without a key is rejected and writes nothing", () => {
    const store = createSqliteSettingsStore({ path: ":memory:" });
    expect(() =>
      store.apply({
        set: [
          { key: "a", json: '"x"', secret: false },
          { key: "b", json: '"y"', secret: true },
        ],
      }),
    ).toThrow(SecretsUnavailableError);
    expect(store.all()).toEqual({});
  });

  test("secrets are encrypted at rest and decrypt on read", () => {
    const path = tempDb();
    const store = createSqliteSettingsStore({ path, encryptionKey: "k" });
    store.apply({ set: [{ key: "github.token", json: JSON.stringify("ghp_secret"), secret: true }] });
    expect(store.all()["github.token"]).toEqual({ secret: true, json: '"ghp_secret"' });
    const raw = new Database(path, { readonly: true }).query("SELECT value, secret FROM settings").get() as { value: string; secret: number };
    expect(raw.secret).toBe(1);
    expect(raw.value).not.toContain("ghp_secret");
    store.close();
  });

  test("a secret read with the wrong or missing key is unreadable, not leaked", () => {
    const path = tempDb();
    const writer = createSqliteSettingsStore({ path, encryptionKey: "one" });
    writer.apply({ set: [{ key: "k", json: '"v"', secret: true }] });
    writer.close();
    expect(createSqliteSettingsStore({ path, encryptionKey: "two" }).all().k).toEqual({ secret: true, json: null });
    expect(createSqliteSettingsStore({ path }).all().k).toEqual({ secret: true, json: null });
  });

  test("remove deletes and set overwrites", () => {
    const store = createSqliteSettingsStore({ path: ":memory:", encryptionKey: "k" });
    store.apply({ set: [{ key: "a", json: "1", secret: false }, { key: "b", json: "2", secret: false }] });
    store.apply({ set: [{ key: "a", json: "3", secret: false }], remove: ["b"] });
    expect(store.all()).toEqual({ a: { secret: false, json: "3" } });
  });
});

describe("projects", () => {
  test("a fresh database has only the default project", () => {
    const db = createSqliteSettingsStore({ path: ":memory:" });
    expect(db.projects()).toMatchObject([{ id: DEFAULT_PROJECT_ID, name: "Default", domain: null }]);
  });

  test("settings and claims from before projects move into the default project, once", () => {
    const path = tempDb();
    const legacy = new Database(path);
    legacy.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, secret INTEGER NOT NULL, updated_at TEXT NOT NULL)");
    legacy.run("INSERT INTO settings VALUES ('sentry.levels', '[\"error\"]', 0, 'x')");
    legacy.run("CREATE TABLE claims (key TEXT PRIMARY KEY, status TEXT NOT NULL, claimed_at INTEGER NOT NULL)");
    legacy.run("INSERT INTO claims VALUES ('posthog-weekly-report:2026-W45', 'done', 1)");
    legacy.close();

    createSqliteSettingsStore({ path }).close();
    const db = createSqliteSettingsStore({ path });
    expect(db.all()).toEqual({ "sentry.levels": { secret: false, json: '["error"]' } });
    expect(db.project(DEFAULT_PROJECT_ID).all()).toEqual(db.all());
    const claims = new Database(path, { readonly: true }).query("SELECT key FROM claims").all();
    expect(claims).toEqual([{ key: "default/posthog-weekly-report:2026-W45" }]);
  });

  test("each project has its own settings", () => {
    const db = createSqliteSettingsStore({ path: ":memory:", encryptionKey: "k" });
    const acme = db.createProject({ name: "Acme" });
    db.project(acme.id).apply({ set: [{ key: "github.token", json: '"acme"', secret: true }] });
    db.apply({ set: [{ key: "github.token", json: '"default"', secret: true }] });
    expect(db.project(acme.id).all()["github.token"]?.json).toBe('"acme"');
    expect(db.all()["github.token"]?.json).toBe('"default"');
  });

  test("ids are unique slugs of the name and domains are normalized", () => {
    const db = createSqliteSettingsStore({ path: ":memory:" });
    expect(db.createProject({ name: "  Fire Prompts!  ", domain: "https://www.FirePrompts.com/app" })).toMatchObject({
      id: "fire-prompts",
      name: "Fire Prompts!",
      domain: "fireprompts.com",
    });
    expect(db.createProject({ name: "Fire prompts" }).id).toBe("fire-prompts-2");
    expect(db.createProject({ name: "Default" }).id).toBe("default-2");
    expect(db.createProject({ name: "Проект" }).id).toBe("project");
    expect(() => db.createProject({ name: " " })).toThrow(ProjectInputError);
    expect(() => db.createProject({ name: "x", domain: "not a domain" })).toThrow(ProjectInputError);
  });

  test("update keeps the id, delete removes the project and its settings, and the default stays", () => {
    const db = createSqliteSettingsStore({ path: ":memory:" });
    const p = db.createProject({ name: "Acme" });
    expect(db.updateProject(p.id, { name: "Acme Inc", domain: "acme.com" })).toMatchObject({ id: "acme", name: "Acme Inc", domain: "acme.com" });
    expect(db.updateProject(p.id, { domain: "" })?.domain).toBeNull();
    expect(db.updateProject("nope", { name: "x" })).toBeNull();

    db.project(p.id).apply({ set: [{ key: "sentry.levels", json: "[]", secret: false }] });
    expect(db.deleteProject(p.id)).toBe(true);
    expect(db.getProject(p.id)).toBeNull();
    expect(db.project(p.id).all()).toEqual({});
    expect(db.deleteProject(p.id)).toBe(false);
    expect(() => db.deleteProject(DEFAULT_PROJECT_ID)).toThrow(ProjectInputError);
  });
});

describe("shared database", () => {
  test("a project store cannot close the shared database; only its owner can", () => {
    const db = createSqliteSettingsStore({ path: ":memory:" });
    const acme = db.project(db.createProject({ name: "Acme" }).id);
    // @ts-expect-error
    expect(acme.close).toBeUndefined();
    acme.apply({ set: [{ key: "a", json: "1", secret: false }] });
    expect(db.project("acme").all()).toEqual({ a: { secret: false, json: "1" } });
    db.close();
    expect(() => acme.all()).toThrow();
  });

  test("projects whose ids share a prefix keep their settings apart", () => {
    const db = createSqliteSettingsStore({ path: ":memory:" });
    const ids = ["Acme", "Acme", "Acme 2"].map((name) => db.createProject({ name }).id);
    expect(ids).toEqual(["acme", "acme-2", "acme-2-2"]);
    for (const id of ids) db.project(id).apply({ set: [{ key: "owner", json: JSON.stringify(id), secret: false }] });
    for (const id of ids) expect(db.project(id).all()).toEqual({ owner: { secret: false, json: JSON.stringify(id) } });
    db.deleteProject("acme");
    expect(db.project("acme").all()).toEqual({});
    expect(db.project("acme-2").all().owner?.json).toBe('"acme-2"');
  });

  test("a database from before versioned schemas keeps its projects and settings across reopens", () => {
    const path = tempDb();
    const old = new Database(path);
    old.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, secret INTEGER NOT NULL, updated_at TEXT NOT NULL)");
    old.run("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, domain TEXT, created_at TEXT NOT NULL)");
    old.run("INSERT INTO projects VALUES ('default', 'Default', NULL, '2026-01-01'), ('acme', 'Acme', 'acme.com', '2026-01-02')");
    old.run("INSERT INTO settings VALUES ('default:sentry.levels', '[\"error\"]', 0, 'x'), ('acme:sentry.levels', '[\"warning\"]', 0, 'x')");
    old.close();

    for (let i = 0; i < 2; i++) {
      const db = createSqliteSettingsStore({ path });
      expect(db.projects().map((p) => p.id)).toEqual(["default", "acme"]);
      expect(db.all()).toEqual({ "sentry.levels": { secret: false, json: '["error"]' } });
      expect(db.project("acme").all()).toEqual({ "sentry.levels": { secret: false, json: '["warning"]' } });
      db.close();
    }
  });

  test("claims, activity and settings in one file each upgrade on their own, in any opening order", () => {
    const path = tempDb();
    const legacy = new Database(path);
    legacy.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, secret INTEGER NOT NULL, updated_at TEXT NOT NULL)");
    legacy.run("INSERT INTO settings VALUES ('sentry.levels', '[\"error\"]', 0, 'x')");
    legacy.close();

    const claims = createSqliteStore({ path });
    const activity = createSqliteActivityStore({ path });
    const settings = createSqliteSettingsStore({ path });
    expect(settings.all()).toEqual({ "sentry.levels": { secret: false, json: '["error"]' } });
    expect(claims.claim("default/job:k")).toBe(true);
    activity.startRun({ automation: "a", source: "s", kind: "k", externalId: "e", startedAt: "2026-01-01T00:00:00.000Z" });
    for (const s of [claims, activity, settings]) s.close();

    const again = createSqliteSettingsStore({ path });
    expect(again.all()).toEqual({ "sentry.levels": { secret: false, json: '["error"]' } });
    again.close();
  });
});

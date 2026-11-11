import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSecretBox } from "../src/crypto";
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

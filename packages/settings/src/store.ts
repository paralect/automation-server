import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { createSecretBox } from "./crypto";

export class SecretsUnavailableError extends Error {
  constructor() {
    super("SETTINGS_ENCRYPTION_KEY is not set, so secrets cannot be stored. Set it and restart the server.");
  }
}

export type StoredSetting = {
  readonly secret: boolean;
  /** JSON text of the value. null when a secret cannot be decrypted (key missing or changed). */
  readonly json: string | null;
};

export type SettingWrite = { readonly key: string; readonly json: string; readonly secret: boolean };

export type SettingsStore = {
  readonly canStoreSecrets: boolean;
  all(): Record<string, StoredSetting>;
  /** Applies every write and delete in one transaction. Throws SecretsUnavailableError before writing anything. */
  apply(changes: { set?: readonly SettingWrite[]; remove?: readonly string[] }): void;
  close(): void;
};

export type SqliteSettingsStoreOptions = {
  path: string;
  encryptionKey?: string;
  now?: () => Date;
};

export function createSqliteSettingsStore({ path, encryptionKey, now = () => new Date() }: SqliteSettingsStoreOptions): SettingsStore {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA journal_mode = WAL");
  db.run(
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, secret INTEGER NOT NULL, updated_at TEXT NOT NULL)",
  );

  const box = encryptionKey ? createSecretBox(encryptionKey) : undefined;
  const selectAll = db.query("SELECT key, value, secret FROM settings");
  const upsert = db.query(
    `INSERT INTO settings (key, value, secret, updated_at) VALUES ($key, $value, $secret, $updatedAt)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, secret = excluded.secret, updated_at = excluded.updated_at`,
  );
  const del = db.query("DELETE FROM settings WHERE key = $key");

  const write = db.transaction((set: readonly SettingWrite[], remove: readonly string[]) => {
    const updatedAt = now().toISOString();
    for (const key of remove) del.run({ $key: key });
    for (const { key, json, secret } of set) {
      upsert.run({ $key: key, $value: secret && box ? box.seal(json) : json, $secret: secret ? 1 : 0, $updatedAt: updatedAt });
    }
  });

  return {
    canStoreSecrets: box !== undefined,
    all() {
      const out: Record<string, StoredSetting> = {};
      for (const row of selectAll.all() as { key: string; value: string; secret: number }[]) {
        const secret = row.secret === 1;
        out[row.key] = { secret, json: secret ? (box?.open(row.value) ?? null) : row.value };
      }
      return out;
    },
    apply({ set = [], remove = [] }) {
      if (!box && set.some((w) => w.secret)) throw new SecretsUnavailableError();
      write(set, remove);
    },
    close() {
      db.close();
    },
  };
}

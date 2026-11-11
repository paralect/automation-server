import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { createSecretBox } from "./crypto";
import {
  DEFAULT_PROJECT_ID,
  normalizeDomain,
  normalizeName,
  ProjectInputError,
  projectIdFor,
  type Project,
} from "./projects";

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

/** The settings of one project. Keys are `<integration>.<field>`, without the project. */
export type SettingsStore = {
  readonly canStoreSecrets: boolean;
  all(): Record<string, StoredSetting>;
  /** Applies every write and delete in one transaction. Throws SecretsUnavailableError before writing anything. */
  apply(changes: { set?: readonly SettingWrite[]; remove?: readonly string[] }): void;
  close(): void;
};

/**
 * The settings database. Used directly it is the default project's settings, so callers that predate
 * projects keep working. `project(id)` gives another project's settings.
 */
export type SettingsDb = SettingsStore & {
  project(id: string): SettingsStore;
  projects(): Project[];
  getProject(id: string): Project | null;
  createProject(input: { name: string; domain?: string | null }): Project;
  /** Returns null for an unknown project. The id never changes. */
  updateProject(id: string, input: { name?: string; domain?: string | null }): Project | null;
  /** Deletes the project and its settings. The default project cannot be deleted. */
  deleteProject(id: string): boolean;
};

export type SqliteSettingsStoreOptions = {
  path: string;
  encryptionKey?: string;
  now?: () => Date;
};

type ProjectRow = { id: string; name: string; domain: string | null; created_at: string };

const toProject = (row: ProjectRow): Project => ({ id: row.id, name: row.name, domain: row.domain, createdAt: row.created_at });

const tableExists = (db: Database, name: string) =>
  db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = $name").get({ $name: name }) !== null;

export function createSqliteSettingsStore({ path, encryptionKey, now = () => new Date() }: SqliteSettingsStoreOptions): SettingsDb {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA journal_mode = WAL");
  db.run(
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, secret INTEGER NOT NULL, updated_at TEXT NOT NULL)",
  );

  // First start with projects: everything configured so far becomes the default project. Setting keys
  // gain the project prefix, and so do claim keys, so a weekly job that already ran this week does not
  // run again under its new project-scoped key.
  db.transaction(() => {
    if (tableExists(db, "projects")) return;
    db.run("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, domain TEXT, created_at TEXT NOT NULL)");
    db.query("INSERT INTO projects (id, name, domain, created_at) VALUES ($id, 'Default', NULL, $at)").run({
      $id: DEFAULT_PROJECT_ID,
      $at: now().toISOString(),
    });
    db.query("UPDATE settings SET key = $prefix || key").run({ $prefix: `${DEFAULT_PROJECT_ID}:` });
    if (tableExists(db, "claims")) db.query("UPDATE claims SET key = $prefix || key").run({ $prefix: `${DEFAULT_PROJECT_ID}/` });
  })();

  const box = encryptionKey ? createSecretBox(encryptionKey) : undefined;
  const selectProject = db.query<{ key: string; value: string; secret: number }, { $prefix: string; $len: number }>(
    "SELECT substr(key, $len + 1) AS key, value, secret FROM settings WHERE substr(key, 1, $len) = $prefix",
  );
  const upsert = db.query(
    `INSERT INTO settings (key, value, secret, updated_at) VALUES ($key, $value, $secret, $updatedAt)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, secret = excluded.secret, updated_at = excluded.updated_at`,
  );
  const del = db.query("DELETE FROM settings WHERE key = $key");
  const delProject = db.query("DELETE FROM settings WHERE substr(key, 1, $len) = $prefix");
  const listProjects = db.query<ProjectRow, []>("SELECT * FROM projects ORDER BY created_at, rowid");
  const projectById = db.query<ProjectRow, { $id: string }>("SELECT * FROM projects WHERE id = $id");
  const insertProject = db.query("INSERT INTO projects (id, name, domain, created_at) VALUES ($id, $name, $domain, $at)");
  const renameProject = db.query("UPDATE projects SET name = $name, domain = $domain WHERE id = $id");
  const removeProject = db.query("DELETE FROM projects WHERE id = $id");

  const write = db.transaction((prefix: string, set: readonly SettingWrite[], remove: readonly string[]) => {
    const updatedAt = now().toISOString();
    for (const key of remove) del.run({ $key: prefix + key });
    for (const { key, json, secret } of set) {
      upsert.run({ $key: prefix + key, $value: secret && box ? box.seal(json) : json, $secret: secret ? 1 : 0, $updatedAt: updatedAt });
    }
  });

  const scoped = (id: string): SettingsStore => {
    const prefix = `${id}:`;
    return {
      canStoreSecrets: box !== undefined,
      all() {
        const out: Record<string, StoredSetting> = {};
        for (const row of selectProject.all({ $prefix: prefix, $len: prefix.length })) {
          const secret = row.secret === 1;
          out[row.key] = { secret, json: secret ? (box?.open(row.value) ?? null) : row.value };
        }
        return out;
      },
      apply({ set = [], remove = [] }) {
        if (!box && set.some((w) => w.secret)) throw new SecretsUnavailableError();
        write(prefix, set, remove);
      },
      close() {
        db.close();
      },
    };
  };

  const getProject = (id: string) => {
    const row = projectById.get({ $id: id });
    return row ? toProject(row) : null;
  };

  return {
    ...scoped(DEFAULT_PROJECT_ID),
    project: scoped,
    projects: () => listProjects.all().map(toProject),
    getProject,
    createProject(input) {
      const name = normalizeName(input.name);
      const domain = normalizeDomain(input.domain);
      const create = db.transaction(() => {
        const id = projectIdFor(name, new Set(listProjects.all().map((p) => p.id)));
        insertProject.run({ $id: id, $name: name, $domain: domain, $at: now().toISOString() });
        return id;
      });
      return getProject(create())!;
    },
    updateProject(id, input) {
      const current = getProject(id);
      if (!current) return null;
      const name = input.name === undefined ? current.name : normalizeName(input.name);
      const domain = input.domain === undefined ? current.domain : normalizeDomain(input.domain);
      renameProject.run({ $id: id, $name: name, $domain: domain });
      return getProject(id);
    },
    deleteProject(id) {
      if (id === DEFAULT_PROJECT_ID) throw new ProjectInputError("The default project cannot be deleted");
      const prefix = `${id}:`;
      return db.transaction(() => {
        delProject.run({ $prefix: prefix, $len: prefix.length });
        return removeProject.run({ $id: id }).changes > 0;
      })();
    },
  };
}

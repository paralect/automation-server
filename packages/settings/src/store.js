import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "@automation-server/core/sqliteSchema";
import { createSecretBox } from "./crypto";
import { DEFAULT_PROJECT_ID, normalizeDomain, normalizeName, ProjectInputError, projectIdFor, } from "./projects";
export class SecretsUnavailableError extends Error {
    constructor() {
        super("SETTINGS_ENCRYPTION_KEY is not set, so secrets cannot be stored. Set it and restart the server.");
    }
}
const toProject = (row) => ({ id: row.id, name: row.name, domain: row.domain, createdAt: row.created_at });
// Every key of a project starts with "<id>:", and ";" is the character right after ":", so this range is exactly that prefix and can use the key index.
const keyRange = (id) => ({ $from: `${id}:`, $to: `${id};` });
const tableExists = (db, name) => db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = $name").get({ $name: name }) !== null;
export function createSqliteSettingsStore({ path, encryptionKey, now = () => new Date() }) {
    if (path !== ":memory:")
        mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA journal_mode = WAL");
    migrate(db, "settings", [
        (db) => {
            db.run("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, secret INTEGER NOT NULL, updated_at TEXT NOT NULL)");
            if (tableExists(db, "projects"))
                return;
            db.run("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, domain TEXT, created_at TEXT NOT NULL)");
            db.query("INSERT INTO projects (id, name, domain, created_at) VALUES ($id, 'Default', NULL, $at)").run({
                $id: DEFAULT_PROJECT_ID,
                $at: now().toISOString(),
            });
            // Claim keys are re-prefixed too so a weekly job that already ran this week does not rerun under its project-scoped key.
            db.query("UPDATE settings SET key = $prefix || key").run({ $prefix: `${DEFAULT_PROJECT_ID}:` });
            if (tableExists(db, "claims"))
                db.query("UPDATE claims SET key = $prefix || key").run({ $prefix: `${DEFAULT_PROJECT_ID}/` });
        },
    ]);
    const box = encryptionKey ? createSecretBox(encryptionKey) : undefined;
    const selectProject = db.query("SELECT substr(key, $len + 1) AS key, value, secret FROM settings WHERE key >= $from AND key < $to");
    const upsert = db.query(`INSERT INTO settings (key, value, secret, updated_at) VALUES ($key, $value, $secret, $updatedAt)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, secret = excluded.secret, updated_at = excluded.updated_at`);
    const del = db.query("DELETE FROM settings WHERE key = $key");
    const delProject = db.query("DELETE FROM settings WHERE key >= $from AND key < $to");
    const listProjects = db.query("SELECT * FROM projects ORDER BY created_at, rowid");
    const projectById = db.query("SELECT * FROM projects WHERE id = $id");
    const insertProject = db.query("INSERT INTO projects (id, name, domain, created_at) VALUES ($id, $name, $domain, $at)");
    const renameProject = db.query("UPDATE projects SET name = $name, domain = $domain WHERE id = $id");
    const removeProject = db.query("DELETE FROM projects WHERE id = $id");
    const write = db.transaction((prefix, set, remove) => {
        const updatedAt = now().toISOString();
        for (const key of remove)
            del.run({ $key: prefix + key });
        for (const { key, json, secret } of set) {
            upsert.run({ $key: prefix + key, $value: secret && box ? box.seal(json) : json, $secret: secret ? 1 : 0, $updatedAt: updatedAt });
        }
    });
    const scoped = (id) => {
        const range = keyRange(id);
        const prefix = range.$from;
        return {
            canStoreSecrets: box !== undefined,
            all() {
                const out = {};
                for (const row of selectProject.all({ ...range, $len: prefix.length })) {
                    const secret = row.secret === 1;
                    out[row.key] = { secret, json: secret ? (box?.open(row.value) ?? null) : row.value };
                }
                return out;
            },
            apply({ set = [], remove = [] }) {
                if (!box && set.some((w) => w.secret))
                    throw new SecretsUnavailableError();
                write(prefix, set, remove);
            },
        };
    };
    const getProject = (id) => {
        const row = projectById.get({ $id: id });
        return row ? toProject(row) : null;
    };
    return {
        ...scoped(DEFAULT_PROJECT_ID),
        close: () => db.close(),
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
            return getProject(create.immediate());
        },
        updateProject(id, input) {
            return db.transaction(() => {
                const current = getProject(id);
                if (!current)
                    return null;
                const name = input.name === undefined ? current.name : normalizeName(input.name);
                const domain = input.domain === undefined ? current.domain : normalizeDomain(input.domain);
                renameProject.run({ $id: id, $name: name, $domain: domain });
                return getProject(id);
            }).immediate();
        },
        deleteProject(id) {
            if (id === DEFAULT_PROJECT_ID)
                throw new ProjectInputError("The default project cannot be deleted");
            return db.transaction(() => {
                delProject.run(keyRange(id));
                return removeProject.run({ $id: id }).changes > 0;
            })();
        },
    };
}

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { migrate } from "@automation-server/core/sqliteSchema";

import type { ConnectionTestResult } from "./update";

export type IntegrationHealth = {
  readonly checkedAt: string;
  readonly ok: boolean;
  readonly message: string;
  readonly expiresAt?: string;
};

export type StoredHealth = IntegrationHealth & { readonly alertedExpiry?: string };

export type HealthStore = {
  get(project: string): Readonly<Record<string, StoredHealth>>;
  put(project: string, integration: string, result: Pick<ConnectionTestResult, "ok" | "message" | "expiresAt">, now: Date): StoredHealth;
  markExpiryAlerted(project: string, integration: string, marker: string): void;
  close(): void;
};

type HealthRow = {
  integration: string;
  checked_at: string;
  ok: number;
  message: string;
  expires_at: string | null;
  alerted_expiry: string | null;
};

const MAX_MESSAGE_CHARS = 500;

export function parseExpiry(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

const toStored = (row: HealthRow): StoredHealth => ({
  checkedAt: row.checked_at,
  ok: row.ok === 1,
  message: row.message,
  ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
  ...(row.alerted_expiry ? { alertedExpiry: row.alerted_expiry } : {}),
});

export function createSqliteHealthStore({ path }: { path: string }): HealthStore {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA journal_mode = WAL");
  migrate(db, "health", [
    (db) => {
      db.run(
        `CREATE TABLE IF NOT EXISTS integration_health (
          project TEXT NOT NULL,
          integration TEXT NOT NULL,
          checked_at TEXT NOT NULL,
          ok INTEGER NOT NULL,
          message TEXT NOT NULL,
          expires_at TEXT,
          alerted_expiry TEXT,
          PRIMARY KEY (project, integration)
        )`,
      );
    },
  ]);

  const select = db.query<HealthRow, { $project: string }>("SELECT * FROM integration_health WHERE project = $project");
  const selectOne = db.query<HealthRow, { $project: string; $integration: string }>(
    "SELECT * FROM integration_health WHERE project = $project AND integration = $integration",
  );
  const upsert = db.query(
    `INSERT INTO integration_health (project, integration, checked_at, ok, message, expires_at)
     VALUES ($project, $integration, $checkedAt, $ok, $message, $expiresAt)
     ON CONFLICT(project, integration) DO UPDATE SET
       checked_at = excluded.checked_at, ok = excluded.ok, message = excluded.message, expires_at = excluded.expires_at`,
  );
  const mark = db.query("UPDATE integration_health SET alerted_expiry = $marker WHERE project = $project AND integration = $integration");

  return {
    get(project) {
      const out: Record<string, StoredHealth> = {};
      for (const row of select.all({ $project: project })) out[row.integration] = toStored(row);
      return out;
    },
    put(project, integration, result, now) {
      const params = {
        $project: project,
        $integration: integration,
        $checkedAt: now.toISOString(),
        $ok: result.ok ? 1 : 0,
        $message: result.message.slice(0, MAX_MESSAGE_CHARS),
        $expiresAt: parseExpiry(result.expiresAt) ?? null,
      };
      return db.transaction(() => {
        upsert.run(params);
        return toStored(selectOne.get({ $project: project, $integration: integration })!);
      })();
    },
    markExpiryAlerted(project, integration, marker) {
      mark.run({ $project: project, $integration: integration, $marker: marker });
    },
    close: () => db.close(),
  };
}

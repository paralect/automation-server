import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "./sqliteSchema";
export function createSqliteStore({ path, leaseMs = 300_000, now = Date.now }) {
    if (path !== ":memory:")
        mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA journal_mode = WAL");
    migrate(db, "claims", [
        (db) => db.run("CREATE TABLE IF NOT EXISTS claims (key TEXT PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('pending','done')), claimed_at INTEGER NOT NULL)"),
    ]);
    const claimStmt = db.query(`INSERT INTO claims (key, status, claimed_at) VALUES ($key, 'pending', $now)
     ON CONFLICT(key) DO UPDATE SET claimed_at = excluded.claimed_at
     WHERE claims.status = 'pending' AND claims.claimed_at <= $expiredBefore`);
    const completeStmt = db.query("UPDATE claims SET status = 'done' WHERE key = $key");
    const releaseStmt = db.query("DELETE FROM claims WHERE key = $key AND status = 'pending'");
    return {
        claim(key) {
            const t = now();
            return claimStmt.run({ $key: key, $now: t, $expiredBefore: t - leaseMs }).changes > 0;
        },
        complete(key) {
            completeStmt.run({ $key: key });
        },
        release(key) {
            releaseStmt.run({ $key: key });
        },
        close() {
            db.close();
        },
    };
}

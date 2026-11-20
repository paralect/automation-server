import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { canTransition, isTerminal } from "./pendingActions";
import { migrate } from "./sqliteSchema";
const toAction = (row) => ({
    id: row.id,
    project: row.project,
    team: row.team,
    channel: row.channel,
    threadTs: row.thread_ts,
    requestedBy: row.requested_by,
    tool: row.tool,
    args: JSON.parse(row.args),
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
    ...(row.result_text === null ? {} : { resultText: row.result_text }),
});
export function createSqlitePendingActionStore({ path, now = Date.now }) {
    if (path !== ":memory:")
        mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA journal_mode = WAL");
    migrate(db, "pending_actions", [
        (db) => {
            db.run(`CREATE TABLE pending_actions (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        team TEXT NOT NULL,
        channel TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        tool TEXT NOT NULL,
        args TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','approved','cancelled','expired','executed','failed')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        resolved_at INTEGER,
        result_text TEXT
      )`);
            db.run("CREATE UNIQUE INDEX pending_actions_one_per_thread ON pending_actions (project, channel, thread_ts) WHERE status = 'pending'");
            db.run("CREATE INDEX pending_actions_expiry ON pending_actions (expires_at) WHERE status = 'pending'");
        },
    ]);
    const cancelOlder = db.query("UPDATE pending_actions SET status = 'cancelled', resolved_at = $now WHERE project = $project AND channel = $channel AND thread_ts = $threadTs AND status = 'pending'");
    const insert = db.query(`INSERT INTO pending_actions (id, project, team, channel, thread_ts, requested_by, tool, args, status, created_at, expires_at)
     VALUES ($id, $project, $team, $channel, $threadTs, $requestedBy, $tool, $args, 'pending', $now, $expiresAt)`);
    const byId = db.query("SELECT * FROM pending_actions WHERE id = $id");
    const forThread = db.query("SELECT * FROM pending_actions WHERE project = $project AND channel = $channel AND thread_ts = $threadTs AND status = 'pending'");
    const move = db.query("UPDATE pending_actions SET status = $to, resolved_at = $resolvedAt, result_text = COALESCE($resultText, result_text) WHERE id = $id AND status = $from");
    const expire = db.query("UPDATE pending_actions SET status = 'expired', resolved_at = $now WHERE status = 'pending' AND expires_at <= $now");
    const prune = db.query("DELETE FROM pending_actions WHERE expires_at < $cutoff OR (status != 'pending' AND resolved_at IS NOT NULL AND resolved_at < $cutoff)");
    const create = db.transaction((action) => {
        const t = now();
        const id = crypto.randomUUID();
        cancelOlder.run({ $now: t, $project: action.project, $channel: action.channel, $threadTs: action.threadTs });
        insert.run({
            $id: id,
            $project: action.project,
            $team: action.team,
            $channel: action.channel,
            $threadTs: action.threadTs,
            $requestedBy: action.requestedBy,
            $tool: action.tool,
            $args: JSON.stringify(action.args ?? null),
            $now: t,
            $expiresAt: action.expiresAt,
        });
        return toAction(byId.get({ $id: id }));
    });
    return {
        create: (action) => create.immediate(action),
        get(id) {
            const row = byId.get({ $id: id });
            return row ? toAction(row) : null;
        },
        findPendingForThread(project, channel, threadTs) {
            const row = forThread.get({ $project: project, $channel: channel, $threadTs: threadTs });
            return row ? toAction(row) : null;
        },
        transition(id, from, to, resultText) {
            if (!canTransition(from, to))
                throw new Error(`pending action cannot go from ${from} to ${to}`);
            const { changes } = move.run({
                $id: id,
                $from: from,
                $to: to,
                $resolvedAt: isTerminal(to) ? now() : null,
                $resultText: resultText ?? null,
            });
            return changes > 0;
        },
        expireOlderThan: (at) => expire.run({ $now: at }).changes,
        prune(beforeIso) {
            const cutoff = Date.parse(beforeIso);
            if (Number.isNaN(cutoff))
                throw new Error(`invalid prune cutoff: ${beforeIso}`);
            return prune.run({ $cutoff: cutoff }).changes;
        },
        close() {
            db.close();
        },
    };
}

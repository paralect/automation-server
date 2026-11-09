import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ActivityBucket,
  ActivityStats,
  ActivityStore,
  LogEntry,
  LogLevel,
  Page,
  RunRecord,
  RunStart,
  RunStatus,
  StoredLog,
  StoredRun,
} from "./activity";

export type SqliteActivityStoreOptions = {
  path: string;
  now?: () => number;
};

type LogRow = {
  id: number;
  time: string;
  level: LogLevel;
  message: string;
  source: string | null;
  automation: string | null;
  external_id: string | null;
  run_id: string | null;
  fields: string;
};

type RunRow = {
  seq: number;
  id: string;
  automation: string;
  source: string;
  kind: string;
  external_id: string;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  error: string | null;
};

const asString = (value: unknown) => (typeof value === "string" ? value : null);
const escapeLike = (value: string) => `%${value.replace(/[\\%_]/g, "\\$&")}%`;
const LOG_LEVELS: LogLevel[] = ["info", "warn", "error"];
const RUN_STATUSES: RunStatus[] = ["running", "succeeded", "failed", "duplicate"];

const toLog = (row: LogRow): StoredLog => {
  const { id, time, level, message } = row;
  return {
    id,
    time,
    level,
    message,
    fields: JSON.parse(row.fields),
    source: row.source,
    automation: row.automation,
    externalId: row.external_id,
    runId: row.run_id,
  };
};

const toRun = (row: RunRow): StoredRun => ({
  seq: row.seq,
  id: row.id,
  automation: row.automation,
  source: row.source,
  kind: row.kind,
  externalId: row.external_id,
  status: row.status,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  error: row.error,
});

type Params = Record<string, string | number>;

type Filter = { where: string; params: Params };

function buildFilter(
  equals: Record<string, string | undefined>,
  searchColumns: string[],
  search: string | undefined,
  before: number | undefined,
  cursorColumn: string,
): Filter {
  const clauses: string[] = [];
  const params: Params = {};
  for (const [column, value] of Object.entries(equals)) {
    if (value === undefined) continue;
    clauses.push(`${column} = $${column}`);
    params[`$${column}`] = value;
  }
  if (search) {
    clauses.push(`(${searchColumns.map((c) => `${c} LIKE $search ESCAPE '\\'`).join(" OR ")})`);
    params.$search = escapeLike(search);
  }
  if (before !== undefined) {
    clauses.push(`${cursorColumn} < $before`);
    params.$before = before;
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export function createSqliteActivityStore({ path, now = Date.now }: SqliteActivityStoreOptions): ActivityStore {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA journal_mode = WAL");
  db.run(`CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time TEXT NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('info','warn','error')),
    message TEXT NOT NULL,
    source TEXT,
    automation TEXT,
    external_id TEXT,
    run_id TEXT,
    fields TEXT NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS logs_run_id ON logs (run_id)");
  db.run("CREATE INDEX IF NOT EXISTS logs_level_id ON logs (level, id)");
  db.run("CREATE INDEX IF NOT EXISTS logs_time ON logs (time)");
  db.run(`CREATE TABLE IF NOT EXISTS runs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    automation TEXT NOT NULL,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    external_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','duplicate')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error TEXT
  )`);
  db.run("CREATE INDEX IF NOT EXISTS runs_status_seq ON runs (status, seq)");
  db.run("CREATE INDEX IF NOT EXISTS runs_automation ON runs (automation)");
  db.run("CREATE INDEX IF NOT EXISTS runs_external_id ON runs (external_id)");

  const insertLog = db.query(
    `INSERT INTO logs (time, level, message, source, automation, external_id, run_id, fields)
     VALUES ($time, $level, $message, $source, $automation, $externalId, $runId, $fields)`,
  );
  const insertRun = db.query(
    `INSERT INTO runs (id, automation, source, kind, external_id, status, started_at, finished_at)
     VALUES ($id, $automation, $source, $kind, $externalId, $status, $startedAt, $finishedAt)`,
  );
  const finishStmt = db.query(
    "UPDATE runs SET status = $status, finished_at = $finishedAt, error = $error WHERE id = $id AND status = 'running'",
  );
  const interruptStmt = db.query(
    "UPDATE runs SET status = 'failed', finished_at = $finishedAt, error = 'interrupted by server restart' WHERE status = 'running'",
  );
  const pruneLogs = db.query("DELETE FROM logs WHERE time < $before");
  const pruneRuns = db.query("DELETE FROM runs WHERE finished_at IS NOT NULL AND finished_at < $before");
  const runById = db.query<RunRow, { $id: string }>("SELECT * FROM runs WHERE id = $id");
  const logsByRun = db.query<LogRow, { $id: string }>("SELECT * FROM logs WHERE run_id = $id ORDER BY id ASC");

  const start = (run: RunStart, status: RunStatus, finishedAt: string | null) => {
    const id = crypto.randomUUID();
    insertRun.run({
      $id: id,
      $automation: run.automation,
      $source: run.source,
      $kind: run.kind,
      $externalId: run.externalId,
      $status: status,
      $startedAt: run.startedAt,
      $finishedAt: finishedAt,
    });
    return id;
  };

  const paginate = <Row, T>(
    table: string,
    cursorColumn: string,
    filter: Filter,
    limit: number,
    map: (row: Row) => T,
    cursorOf: (item: T) => number,
  ): Page<T> => {
    const rows = db
      .query<Row, Params>(
        `SELECT * FROM ${table} ${filter.where} ORDER BY ${cursorColumn} DESC LIMIT $limit`,
      )
      .all({ ...filter.params, $limit: limit + 1 });
    const items = rows.slice(0, limit).map(map);
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > limit && last ? cursorOf(last) : null };
  };

  return {
    recordLog(entry: LogEntry) {
      const { fields } = entry;
      insertLog.run({
        $time: entry.time,
        $level: entry.level,
        $message: entry.message,
        $source: asString(fields.source),
        $automation: asString(fields.automation),
        $externalId: asString(fields.externalId),
        $runId: asString(fields.runId),
        $fields: JSON.stringify(fields),
      });
    },
    startRun: (run) => start(run, "running", null),
    finishRun(id, { status, error, finishedAt }) {
      finishStmt.run({ $id: id, $status: status, $finishedAt: finishedAt, $error: error ?? null });
    },
    recordDuplicate: (run) => start(run, "duplicate", run.startedAt),
    queryLogs(q) {
      const filter = buildFilter(
        { level: q.level, source: q.source, automation: q.automation, run_id: q.runId },
        ["message", "external_id", "automation"],
        q.search,
        q.before,
        "id",
      );
      return paginate<LogRow, StoredLog>("logs", "id", filter, q.limit, toLog, (l) => l.id);
    },
    queryRuns(q) {
      const filter = buildFilter(
        { status: q.status, automation: q.automation, source: q.source },
        ["automation", "external_id", "error"],
        q.search,
        q.before,
        "seq",
      );
      return paginate<RunRow, StoredRun>("runs", "seq", filter, q.limit, toRun, (r) => r.seq);
    },
    getRun(id) {
      const row = runById.get({ $id: id });
      if (!row) return null;
      const { seq: _seq, ...run } = toRun(row);
      return { run: run satisfies RunRecord, logs: logsByRun.all({ $id: id }).map(toLog) };
    },
    stats(sinceIso, bucketMs): ActivityStats {
      const runs = Object.fromEntries(RUN_STATUSES.map((s) => [s, 0])) as Record<RunStatus, number>;
      for (const r of db
        .query<{ status: RunStatus; n: number }, { $since: string }>(
          "SELECT status, COUNT(*) AS n FROM runs WHERE started_at >= $since GROUP BY status",
        )
        .all({ $since: sinceIso })) {
        runs[r.status] = r.n;
      }
      const logs = Object.fromEntries(LOG_LEVELS.map((l) => [l, 0])) as Record<LogLevel, number>;
      for (const r of db
        .query<{ level: LogLevel; n: number }, { $since: string }>(
          "SELECT level, COUNT(*) AS n FROM logs WHERE time >= $since GROUP BY level",
        )
        .all({ $since: sinceIso })) {
        logs[r.level] = r.n;
      }

      const counted = new Map<number, ActivityBucket>();
      for (const r of db
        .query<{ bucket: number; status: RunStatus; n: number }, { $since: string; $bucketMs: number }>(
          `SELECT (CAST(strftime('%s', started_at) AS INTEGER) * 1000) / $bucketMs AS bucket, status, COUNT(*) AS n
           FROM runs WHERE started_at >= $since AND status IN ('succeeded','failed','duplicate')
           GROUP BY bucket, status`,
        )
        .all({ $since: sinceIso, $bucketMs: bucketMs })) {
        const prev = counted.get(r.bucket) ?? { start: "", succeeded: 0, failed: 0, duplicate: 0 };
        counted.set(r.bucket, { ...prev, [r.status]: r.n });
      }
      const first = Math.floor(Date.parse(sinceIso) / bucketMs);
      const last = Math.floor(now() / bucketMs);
      const buckets: ActivityBucket[] = [];
      for (let b = first; b <= last; b++) {
        const c = counted.get(b);
        buckets.push({
          start: new Date(b * bucketMs).toISOString(),
          succeeded: c?.succeeded ?? 0,
          failed: c?.failed ?? 0,
          duplicate: c?.duplicate ?? 0,
        });
      }

      const recentFailures = db
        .query<RunRow, []>("SELECT * FROM runs WHERE status = 'failed' ORDER BY seq DESC LIMIT 5")
        .all()
        .map((row) => {
          const { seq: _seq, ...run } = toRun(row);
          return run;
        });
      return { runs, logs, buckets, recentFailures };
    },
    failInterruptedRuns: (finishedAt) => interruptStmt.run({ $finishedAt: finishedAt }).changes,
    prune(beforeIso) {
      return pruneLogs.run({ $before: beforeIso }).changes + pruneRuns.run({ $before: beforeIso }).changes;
    },
    close() {
      db.close();
    },
  };
}

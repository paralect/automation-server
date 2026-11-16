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
  RunOutcome,
  RunRecord,
  RunStart,
  RunStatus,
  StoredLog,
  StoredRun,
} from "./activity";

export type SqliteActivityStoreOptions = {
  path: string;
  now?: () => number;
  /** Project given to the runs and logs recorded before projects existed, when the column is first added. */
  legacyProject?: string;
};

type LogRow = {
  id: number;
  project: string | null;
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
  project: string | null;
  automation: string;
  source: string;
  kind: string;
  external_id: string;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  outcome: string | null;
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
    project: row.project,
    source: row.source,
    automation: row.automation,
    externalId: row.external_id,
    runId: row.run_id,
  };
};

const parseOutcome = (raw: string | null): RunOutcome | null => {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RunOutcome) : null;
  } catch {
    return null;
  }
};

const toRun = (row: RunRow): StoredRun => ({
  seq: row.seq,
  id: row.id,
  project: row.project,
  automation: row.automation,
  source: row.source,
  kind: row.kind,
  externalId: row.external_id,
  status: row.status,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  error: row.error,
  outcome: parseOutcome(row.outcome),
});

type Params = Record<string, string | number>;

type Filter = { where: string; params: Params };

function buildFilter(
  equals: Record<string, string | undefined>,
  searchColumns: string[],
  search: string | undefined,
  before: number | undefined,
  cursorColumn: string,
  extra?: Filter,
): Filter {
  const clauses: string[] = extra?.where ? [extra.where] : [];
  const params: Params = { ...extra?.params };
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

// Server-wide lines (startup, reloads) carry no project and show in every project.
const logProject = (project: string | undefined): Filter | undefined =>
  project === undefined ? undefined : { where: "(project = $project OR project IS NULL)", params: { $project: project } };

const hasColumn = (db: Database, table: string, column: string) =>
  (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);

export function createSqliteActivityStore({ path, now = Date.now, legacyProject }: SqliteActivityStoreOptions): ActivityStore {
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
  db.transaction(() => {
    for (const table of ["logs", "runs"]) {
      if (hasColumn(db, table, "project")) continue;
      db.run(`ALTER TABLE ${table} ADD COLUMN project TEXT`);
      if (legacyProject) db.query(`UPDATE ${table} SET project = $project`).run({ $project: legacyProject });
    }
  })();
  if (!hasColumn(db, "runs", "outcome")) db.run("ALTER TABLE runs ADD COLUMN outcome TEXT");
  db.run("CREATE INDEX IF NOT EXISTS logs_project_id ON logs (project, id)");
  db.run("CREATE INDEX IF NOT EXISTS runs_project_seq ON runs (project, seq)");

  const insertLog = db.query(
    `INSERT INTO logs (time, level, message, project, source, automation, external_id, run_id, fields)
     VALUES ($time, $level, $message, $project, $source, $automation, $externalId, $runId, $fields)`,
  );
  const insertRun = db.query(
    `INSERT INTO runs (id, project, automation, source, kind, external_id, status, started_at, finished_at)
     VALUES ($id, $project, $automation, $source, $kind, $externalId, $status, $startedAt, $finishedAt)`,
  );
  const finishStmt = db.query(
    "UPDATE runs SET status = $status, finished_at = $finishedAt, error = $error, outcome = $outcome WHERE id = $id AND status = 'running'",
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
      $project: run.project ?? null,
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
        $project: asString(fields.project),
        $source: asString(fields.source),
        $automation: asString(fields.automation),
        $externalId: asString(fields.externalId),
        $runId: asString(fields.runId),
        $fields: JSON.stringify(fields),
      });
    },
    startRun: (run) => start(run, "running", null),
    finishRun(id, { status, error, finishedAt, outcome }) {
      finishStmt.run({ $id: id, $status: status, $finishedAt: finishedAt, $error: error ?? null, $outcome: outcome ? JSON.stringify(outcome) : null });
    },
    recordDuplicate: (run) => start(run, "duplicate", run.startedAt),
    queryLogs(q) {
      const filter = buildFilter(
        { level: q.level, source: q.source, automation: q.automation, run_id: q.runId },
        ["message", "external_id", "automation"],
        q.search,
        q.before,
        "id",
        logProject(q.project),
      );
      return paginate<LogRow, StoredLog>("logs", "id", filter, q.limit, toLog, (l) => l.id);
    },
    queryRuns(q) {
      const filter = buildFilter(
        { project: q.project, status: q.status, automation: q.automation, source: q.source },
        ["automation", "external_id", "error"],
        q.search,
        q.before,
        "seq",
        q.decision === undefined ? undefined : { where: "json_extract(outcome, '$.decision') = $decision", params: { $decision: q.decision } },
      );
      return paginate<RunRow, StoredRun>("runs", "seq", filter, q.limit, toRun, (r) => r.seq);
    },
    decisionCounts({ project, automation, sinceIso }) {
      const scope = project === undefined ? "" : "AND project = $project";
      const rows = db
        .query<{ decision: string | null; n: number }, Params>(
          `SELECT json_extract(outcome, '$.decision') AS decision, COUNT(*) AS n FROM runs
           WHERE automation = $automation AND started_at >= $since AND (outcome IS NOT NULL OR status = 'failed') ${scope}
           GROUP BY decision`,
        )
        .all({ $automation: automation, $since: sinceIso, ...(project === undefined ? {} : { $project: project }) });
      return Object.fromEntries(rows.map((r) => [r.decision ?? "none", r.n]));
    },
    getRun(id) {
      const row = runById.get({ $id: id });
      if (!row) return null;
      const { seq: _seq, ...run } = toRun(row);
      return { run: run satisfies RunRecord, logs: logsByRun.all({ $id: id }).map(toLog) };
    },
    stats(sinceIso, bucketMs, project): ActivityStats {
      const scoped = project !== undefined;
      const runScope = scoped ? "AND project = $project" : "";
      const logScope = scoped ? "AND (project = $project OR project IS NULL)" : "";
      const params = (extra: Params = {}): Params => ({ ...extra, ...(scoped ? { $project: project } : {}) });

      const runs = Object.fromEntries(RUN_STATUSES.map((s) => [s, 0])) as Record<RunStatus, number>;
      for (const r of db
        .query<{ status: RunStatus; n: number }, Params>(
          `SELECT status, COUNT(*) AS n FROM runs WHERE started_at >= $since ${runScope} GROUP BY status`,
        )
        .all(params({ $since: sinceIso }))) {
        runs[r.status] = r.n;
      }
      const logs = Object.fromEntries(LOG_LEVELS.map((l) => [l, 0])) as Record<LogLevel, number>;
      for (const r of db
        .query<{ level: LogLevel; n: number }, Params>(
          `SELECT level, COUNT(*) AS n FROM logs WHERE time >= $since ${logScope} GROUP BY level`,
        )
        .all(params({ $since: sinceIso }))) {
        logs[r.level] = r.n;
      }

      const counted = new Map<number, ActivityBucket>();
      for (const r of db
        .query<{ bucket: number; status: RunStatus; n: number }, Params>(
          `SELECT (CAST(strftime('%s', started_at) AS INTEGER) * 1000) / $bucketMs AS bucket, status, COUNT(*) AS n
           FROM runs WHERE started_at >= $since AND status IN ('succeeded','failed','duplicate') ${runScope}
           GROUP BY bucket, status`,
        )
        .all(params({ $since: sinceIso, $bucketMs: bucketMs }))) {
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
        .query<RunRow, Params>(`SELECT * FROM runs WHERE status = 'failed' ${runScope} ORDER BY seq DESC LIMIT 5`)
        .all(params())
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

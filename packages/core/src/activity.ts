import type { LogFields } from "./logger";

export type LogLevel = "info" | "warn" | "error";

export type LogEntry = {
  readonly time: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
};

export type StoredLog = LogEntry & {
  readonly id: number;
  readonly project: string | null;
  readonly source: string | null;
  readonly automation: string | null;
  readonly externalId: string | null;
  readonly runId: string | null;
};

export type RunStatus = "running" | "succeeded" | "failed" | "duplicate";

/** What an automation reports about a run, as plain JSON. A `decision` string, when present, can be filtered on. */
export type RunOutcome = Readonly<Record<string, unknown>>;

export type RunRecord = {
  readonly id: string;
  readonly project: string | null;
  readonly automation: string;
  readonly source: string;
  readonly kind: string;
  readonly externalId: string;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly error: string | null;
  /** Reported by the automation through its context, null when it reported nothing. */
  readonly outcome?: RunOutcome | null;
  /** When an operator marked the run as read in the admin, null while unread. */
  readonly readAt?: string | null;
};

export type Page<T> = { readonly items: T[]; readonly nextCursor: number | null };

export type LogQuery = {
  /** Lines of this project plus server-wide lines that belong to no project. */
  project?: string;
  level?: LogLevel;
  source?: string;
  automation?: string;
  runId?: string;
  search?: string;
  before?: number;
  limit: number;
};

export type RunQuery = {
  project?: string;
  /** Matches the `decision` string of the run's reported outcome. */
  decision?: string;
  /** Only runs nobody has marked as read. */
  unread?: boolean;
  status?: RunStatus;
  automation?: string;
  source?: string;
  search?: string;
  before?: number;
  limit: number;
};

export type StoredRun = RunRecord & { readonly seq: number };

export type ActivityBucket = {
  readonly start: string;
  readonly succeeded: number;
  readonly failed: number;
  readonly duplicate: number;
};

export type ActivityStats = {
  readonly runs: Readonly<Record<RunStatus, number>>;
  readonly logs: Readonly<Record<LogLevel, number>>;
  readonly buckets: ActivityBucket[];
  readonly recentFailures: RunRecord[];
};

export type RunStart = Pick<RunRecord, "automation" | "source" | "kind" | "externalId"> & { startedAt: string; project?: string };

export interface ActivityStore {
  recordLog(entry: LogEntry): void;
  startRun(run: RunStart): string;
  finishRun(id: string, result: { status: "succeeded" | "failed"; error?: string; finishedAt: string; outcome?: RunOutcome }): void;
  recordDuplicate(run: RunStart): string;
  queryLogs(query: LogQuery): Page<StoredLog>;
  queryRuns(query: RunQuery): Page<StoredRun>;
  /** Runs of one automation since a time, counted by the `decision` of their outcome. A failed run without an outcome counts under "none"; a finished run without one (recorded before outcomes existed) is left out. */
  decisionCounts(query: { project?: string; automation: string; sinceIso: string }): Record<string, number>;
  /** Marks one run as read (a time) or unread (null). False when no such run exists. */
  setRunRead(id: string, readAt: string | null): boolean;
  /** Marks every unread run of one automation as read. Returns how many changed. */
  markRunsRead(query: { project?: string; automation: string; readAt: string }): number;
  /** Unread runs of one automation that carry a decision or failed, the ones worth an operator's attention. */
  unreadCount(query: { project?: string; automation: string }): number;
  getRun(id: string): { run: RunRecord; logs: StoredLog[] } | null;
  /** With a project, counts that project's runs and its logs plus server-wide logs. */
  stats(sinceIso: string, bucketMs: number, project?: string): ActivityStats;
  failInterruptedRuns(finishedAt: string): number;
  prune(beforeIso: string): number;
  close(): void;
}

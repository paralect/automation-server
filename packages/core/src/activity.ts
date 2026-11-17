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
  readonly outcome?: RunOutcome | null;
  readonly readAt?: string | null;
};

export type Page<T> = { readonly items: T[]; readonly nextCursor: number | null };

export type LogQuery = {
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
  decision?: string;
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
  decisionCounts(query: { project?: string; automation: string; sinceIso: string }): Record<string, number>;
  setRunRead(id: string, readAt: string | null): boolean;
  markRunsRead(query: { project?: string; automation: string; readAt: string }): number;
  unreadCount(query: { project?: string; automation: string }): number;
  getRun(id: string): { run: RunRecord; logs: StoredLog[] } | null;
  stats(sinceIso: string, bucketMs: number, project?: string): ActivityStats;
  failInterruptedRuns(finishedAt: string): number;
  prune(beforeIso: string): number;
  close(): void;
}

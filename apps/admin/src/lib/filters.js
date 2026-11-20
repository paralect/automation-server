import { z } from "zod";
export const LOG_LEVELS = ["info", "warn", "error"];
export const RUN_STATUSES = ["running", "succeeded", "failed", "duplicate"];
const text = z.string().trim().min(1).max(200).optional().catch(undefined);
export const logsSearch = z.object({
    level: z.enum(LOG_LEVELS).optional().catch(undefined),
    source: text,
    automation: text,
    runId: text,
    q: text,
});
export const DRY_RUN_FILTERS = ["include", "exclude", "only"];
export const runsSearch = z.object({
    status: z.enum(RUN_STATUSES).optional().catch(undefined),
    dryRun: z.enum(DRY_RUN_FILTERS).optional().catch(undefined),
    source: text,
    automation: text,
    q: text,
});
const cursor = z.number().int().optional();
const limit = z.number().int().min(1).max(200).default(50);
export const logsInput = logsSearch.extend({ before: cursor, limit });
export const runsInput = runsSearch.extend({ before: cursor, limit });
export const CRISP_DECISIONS = ["issue", "fix", "needs_info", "answer", "drop"];
export const crispSearch = z.object({
    decision: z.enum(CRISP_DECISIONS).optional().catch(undefined),
    unread: z.boolean().optional().catch(undefined),
    q: text,
});
export const crispInput = crispSearch.extend({ before: cursor, limit });
export const WINDOWS = { "24h": 24, "7d": 168 };
export const WINDOW_KEYS = ["24h", "7d"];
export const windowInput = z.object({ window: z.enum(WINDOW_KEYS) });
export const ACTION_STATES = ["queued", "waiting", "running", "success", "failure", "cancelled", "skipped"];
export const actionsSearch = z.object({
    repo: text,
    workflow: text,
    state: z.enum(ACTION_STATES).optional().catch(undefined),
});
export const actionsInput = actionsSearch.extend({ page: z.number().int().min(1).max(50).default(1) });
export const actionRunInput = z.object({ repo: z.string().min(3).max(200), id: z.number().int().positive() });

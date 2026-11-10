import { z } from "zod"

export const LOG_LEVELS = ["info", "warn", "error"] as const
export const RUN_STATUSES = ["running", "succeeded", "failed", "duplicate"] as const

export type LogLevel = (typeof LOG_LEVELS)[number]
export type RunStatus = (typeof RUN_STATUSES)[number]

const text = z.string().trim().min(1).max(200).optional().catch(undefined)

export const logsSearch = z.object({
  level: z.enum(LOG_LEVELS).optional().catch(undefined),
  source: text,
  automation: text,
  runId: text,
  q: text,
})
export type LogsSearch = z.infer<typeof logsSearch>

export const runsSearch = z.object({
  status: z.enum(RUN_STATUSES).optional().catch(undefined),
  source: text,
  automation: text,
  q: text,
})
export type RunsSearch = z.infer<typeof runsSearch>

const cursor = z.number().int().optional()
const limit = z.number().int().min(1).max(200).default(50)

export const logsInput = logsSearch.extend({ before: cursor, limit })
export const runsInput = runsSearch.extend({ before: cursor, limit })

export const WINDOWS = { "24h": 24, "7d": 168 } as const
export type WindowKey = keyof typeof WINDOWS
export const windowInput = z.object({ window: z.enum(["24h", "7d"]) })

export const ACTION_STATES = ["queued", "waiting", "running", "success", "failure", "cancelled", "skipped"] as const
export type ActionState = (typeof ACTION_STATES)[number]

export const actionsSearch = z.object({
  repo: text,
  workflow: text,
  state: z.enum(ACTION_STATES).optional().catch(undefined),
})
export type ActionsSearch = z.infer<typeof actionsSearch>

export const actionsInput = actionsSearch.extend({ page: z.number().int().min(1).max(50).default(1) })
export const actionRunInput = z.object({ repo: z.string().min(3).max(200), id: z.number().int().positive() })

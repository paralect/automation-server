import { z } from "zod"

import type { OutcomeWindowDays, PullRequestState } from "@automation-server/api/routers/index"

import { MONTH_RE } from "./costs"

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

export const DRY_RUN_FILTERS = ["include", "exclude", "only"] as const
export type DryRunFilter = (typeof DRY_RUN_FILTERS)[number]

export const runsSearch = z.object({
  status: z.enum(RUN_STATUSES).optional().catch(undefined),
  dryRun: z.enum(DRY_RUN_FILTERS).optional().catch(undefined),
  source: text,
  automation: text,
  q: text,
})
export type RunsSearch = z.infer<typeof runsSearch>

const cursor = z.number().int().optional()
const limit = z.number().int().min(1).max(200).default(50)

export const logsInput = logsSearch.extend({ before: cursor, limit })
export const runsInput = runsSearch.extend({ before: cursor, limit })

export const CRISP_DECISIONS = ["issue", "fix", "needs_info", "answer", "drop"] as const
export type CrispDecisionKey = (typeof CRISP_DECISIONS)[number]

export const crispSearch = z.object({
  decision: z.enum(CRISP_DECISIONS).optional().catch(undefined),
  unread: z.boolean().optional().catch(undefined),
  q: text,
})
export type CrispSearch = z.infer<typeof crispSearch>
export const crispInput = crispSearch.extend({ before: cursor, limit })

export const WINDOWS = { "24h": 24, "7d": 168 } as const
export type WindowKey = keyof typeof WINDOWS
export const WINDOW_KEYS = ["24h", "7d"] as const satisfies readonly WindowKey[]
export const windowInput = z.object({ window: z.enum(WINDOW_KEYS) })

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

export const OUTCOME_WINDOW_DAYS = [30, 90] as const satisfies readonly OutcomeWindowDays[]
export type OutcomeWindow = (typeof OUTCOME_WINDOW_DAYS)[number]
export const PR_STATES = ["open", "merged", "closed"] as const satisfies readonly PullRequestState[]

export const outcomesSearch = z.object({
  window: z.union([z.literal(30), z.literal(90)]).optional().catch(undefined),
  state: z.enum(PR_STATES).optional().catch(undefined),
  origin: text,
})
export type OutcomesSearch = z.infer<typeof outcomesSearch>
export type PullRequestFilters = Omit<OutcomesSearch, "window">
export const pullRequestsInput = z.object({ state: z.enum(PR_STATES).optional(), origin: text, before: cursor, limit })

const month = z.string().regex(MONTH_RE)
export const costsSearch = z.object({ month: month.optional().catch(undefined) })
export type CostsSearch = z.infer<typeof costsSearch>
export const costsInput = z.object({ month: month.optional() })

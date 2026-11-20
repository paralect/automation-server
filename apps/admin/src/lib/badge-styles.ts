import type { ActionState, LogLevel, RunStatus } from "./filters"
import type { BudgetTone } from "./costs"
import type { PrBadgeState } from "./outcomes"

type BadgeStyle = {
  variant: "default" | "secondary" | "destructive" | "outline"
  className?: string
}

export const STATUS_BADGE: Record<RunStatus, BadgeStyle> = {
  running: { variant: "outline", className: "text-blue-600 dark:text-blue-400" },
  succeeded: { variant: "secondary", className: "text-emerald-700 dark:text-emerald-400" },
  failed: { variant: "destructive" },
  duplicate: { variant: "outline", className: "text-muted-foreground" },
}

export const LEVEL_BADGE: Record<LogLevel, BadgeStyle> = {
  info: { variant: "outline", className: "text-muted-foreground" },
  warn: { variant: "secondary", className: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  error: { variant: "destructive" },
}

export const LEVEL_ROW: Record<LogLevel, string> = {
  info: "",
  warn: "bg-amber-500/5 border-l-2 border-l-amber-500",
  error: "bg-destructive/5 border-l-2 border-l-destructive",
}

export const ACTION_BADGE: Record<ActionState, BadgeStyle> = {
  queued: { variant: "outline", className: "text-muted-foreground" },
  waiting: { variant: "secondary", className: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  running: { variant: "outline", className: "text-blue-600 dark:text-blue-400" },
  success: { variant: "secondary", className: "text-emerald-700 dark:text-emerald-400" },
  failure: { variant: "destructive" },
  cancelled: { variant: "outline", className: "text-muted-foreground" },
  skipped: { variant: "outline", className: "text-muted-foreground" },
}

export const PR_BADGE: Record<PrBadgeState, BadgeStyle> = {
  draft: { variant: "outline", className: "border-dashed text-muted-foreground" },
  open: { variant: "outline", className: "text-blue-600 dark:text-blue-400" },
  merged: { variant: "secondary", className: "bg-pr-merged/12 text-emerald-700 dark:text-emerald-400" },
  closed: { variant: "outline", className: "text-muted-foreground" },
}

export const BUDGET_FILL: Record<BudgetTone, string> = {
  ok: "bg-primary",
  warn: "bg-amber-500",
  over: "bg-destructive",
}

export const BUDGET_TEXT: Record<BudgetTone, string> = {
  ok: "text-muted-foreground",
  warn: "text-amber-700 dark:text-amber-400",
  over: "text-destructive",
}

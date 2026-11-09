import type { LogLevel, RunStatus } from "./filters"

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

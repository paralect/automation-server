import { Badge } from "@/components/ui/badge"
import { LEVEL_BADGE, STATUS_BADGE } from "@/lib/badge-styles"
import type { LogLevel, RunStatus } from "@/lib/filters"

export const StatusBadge = ({ status }: { status: RunStatus }) => (
  <Badge {...STATUS_BADGE[status]}>{status}</Badge>
)

export const LevelBadge = ({ level }: { level: LogLevel }) => (
  <Badge {...LEVEL_BADGE[level]}>{level}</Badge>
)

import { Badge } from "@/components/ui/badge"
import { LEVEL_BADGE, STATUS_BADGE } from "@/lib/badge-styles"
import type { LogLevel, RunStatus } from "@/lib/filters"

export const StatusBadge = ({ status }: { status: RunStatus }) => (
  <Badge {...STATUS_BADGE[status]}>{status}</Badge>
)

export const LevelBadge = ({ level }: { level: LogLevel }) => (
  <Badge {...LEVEL_BADGE[level]}>{level}</Badge>
)

export const DryRunBadge = () => (
  <Badge variant="outline" className="border-dashed text-violet-700 dark:text-violet-400">
    Dry run
  </Badge>
)

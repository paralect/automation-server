import { GitMergeIcon, GitPullRequestIcon, XCircleIcon, type Icon } from "@phosphor-icons/react"

import { Badge } from "@/components/ui/badge"
import { LEVEL_BADGE, PR_BADGE, STATUS_BADGE } from "@/lib/badge-styles"
import type { LogLevel, RunStatus } from "@/lib/filters"
import type { PrBadgeState } from "@/lib/outcomes"

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

const PR_ICON: Record<PrBadgeState, Icon> = {
  draft: GitPullRequestIcon,
  open: GitPullRequestIcon,
  merged: GitMergeIcon,
  closed: XCircleIcon,
}

export function PrStateBadge({ state }: { state: PrBadgeState }) {
  const Glyph = PR_ICON[state]
  return (
    <Badge {...PR_BADGE[state]} data-icon="inline-start">
      <Glyph weight="bold" aria-hidden />
      {state}
    </Badge>
  )
}

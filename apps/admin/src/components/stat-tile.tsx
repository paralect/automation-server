import type { ReactNode } from "react"
import { cn } from "cn"

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

/** One figure with its label. `swatch` ties the tile to the chart series of the same name. */
export function StatTile({
  label,
  value,
  hint,
  swatch,
  loading,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  swatch?: string
  loading?: boolean
}) {
  return (
    <Card size="sm">
      <CardHeader className="gap-1.5">
        <CardDescription className="flex items-center gap-1.5">
          {swatch && <span aria-hidden className={cn("size-2 shrink-0 rounded-full", swatch)} />}
          {label}
        </CardDescription>
        {loading ? (
          <Skeleton className="h-8 w-16" />
        ) : (
          <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
        )}
        {hint !== undefined && !loading && <p className="truncate text-xs text-muted-foreground tabular-nums">{hint}</p>}
      </CardHeader>
    </Card>
  )
}

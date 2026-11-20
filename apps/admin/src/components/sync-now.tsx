import { Link } from "@tanstack/react-router"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ArrowsClockwiseIcon } from "@phosphor-icons/react"

import type { SyncNowResult } from "@automation-server/api/routers/index"

import { Button } from "@/components/ui/button"
import { syncOutcomes } from "@/lib/api.functions"
import { errorText } from "@/lib/errors"
import { outcomesKey, runTraceKey } from "@/lib/queries"
import { formatRelative } from "@/lib/time"
import type { SyncStatus } from "@/lib/outcomes"

export function useSyncNow(project: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => syncOutcomes({ data: { project } }),
    onSuccess: (result) => {
      if (result.status !== "succeeded") return
      void queryClient.invalidateQueries({ queryKey: outcomesKey(project) })
      void queryClient.invalidateQueries({ queryKey: runTraceKey(project) })
    },
  })
}

export function syncedLabel(status: SyncStatus, prefix: string) {
  return status.kind === "never" ? "Not synced yet" : `${prefix} ${formatRelative(status.at)}`
}

export function SyncButton({
  sync,
  label = "Sync now",
  size = "sm",
}: {
  sync: ReturnType<typeof useSyncNow>
  label?: string
  size?: "sm" | "xs"
}) {
  return (
    <Button variant="outline" size={size} onClick={() => sync.mutate()} disabled={sync.isPending}>
      <ArrowsClockwiseIcon data-icon="inline-start" className={sync.isPending ? "motion-safe:animate-spin" : undefined} />
      {sync.isPending ? "Syncing..." : label}
    </Button>
  )
}

/** Says why a sync did not refresh anything. A successful sync speaks through the refreshed data instead. */
export function SyncFeedback({ sync }: { sync: ReturnType<typeof useSyncNow> }) {
  if (sync.error) {
    return (
      <p role="alert" className="text-xs text-destructive">
        {errorText(sync.error)}
      </p>
    )
  }
  const result: SyncNowResult | undefined = sync.data
  if (!result || result.status === "succeeded") return null
  return (
    <p role={result.status === "failed" ? "alert" : "status"} className={result.status === "failed" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
      {result.message}
      {result.status === "failed" && result.runId && (
        <>
          {" "}
          <Link to="/runs/$id" params={{ id: result.runId }} className="underline underline-offset-4">
            Open the sync run
          </Link>
        </>
      )}
    </p>
  )
}

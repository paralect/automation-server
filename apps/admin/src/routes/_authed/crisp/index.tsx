import { useCallback, useState } from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChecksIcon, GearIcon, WarningCircleIcon } from "@phosphor-icons/react"
import { cn } from "cn"

import { CrispPanel, CrispRow, DECISION_VIEW, isCrispMode, MODE_COPY } from "@/components/crisp-triage"
import { TextFilter } from "@/components/filters"
import { EmptyState, PageHeader, QueryError, RowsSkeleton } from "@/components/states"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { markAllCrispRead, markCrispRead, type CrispTriageItem } from "@/lib/api.functions"
import { CRISP_DECISIONS, crispSearch, type CrispSearch } from "@/lib/filters"
import { useProjectId } from "@/lib/project"
import { crispKey, crispQuery, crispStatsKey, crispStatsQuery, settingsQuery } from "@/lib/queries"

export const Route = createFileRoute("/_authed/crisp/")({
  validateSearch: crispSearch,
  component: CrispPage,
})

function CrispPage() {
  const filters = Route.useSearch()
  const navigate = Route.useNavigate()
  const project = useProjectId()

  const update = useCallback(
    (patch: Partial<CrispSearch>) => navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true }),
    [navigate]
  )

  const settings = useQuery(settingsQuery(project))
  const stats = useQuery(crispStatsQuery(project))
  const list = useInfiniteQuery(crispQuery(project, filters))
  const items = list.data?.pages.flatMap((page) => page.items) ?? []

  // The open conversation is kept as a snapshot, so the panel stays put when a refresh or the "Unread" filter drops its row.
  const [opened, setOpened] = useState<CrispTriageItem | null>(null)
  const current = opened ? (items.find((item) => item.id === opened.id) ?? opened) : null

  const queryClient = useQueryClient()
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: crispKey(project) })
    void queryClient.invalidateQueries({ queryKey: crispStatsKey(project) })
  }
  const setRead = useMutation({
    mutationFn: ({ item, read }: { item: CrispTriageItem; read: boolean }) => markCrispRead({ data: { project, id: item.id, read } }),
    onSuccess: (_result, { item, read }) => {
      setOpened((prev) => (prev?.id === item.id ? { ...prev, read } : prev))
      refresh()
    },
  })
  const readAll = useMutation({ mutationFn: () => markAllCrispRead({ data: { project } }), onSuccess: refresh })

  const open = (item: CrispTriageItem) => {
    setOpened(item)
    if (!item.read) setRead.mutate({ item, read: true })
  }

  const integrations = settings.data?.integrations ?? []
  const crisp = integrations.find((i) => i.id === "crisp")
  const value = (key: string) => {
    const field = crisp?.fields.find((f) => f.key === key)
    return field && "value" in field && typeof field.value === "string" ? field.value : undefined
  }
  const rawMode = value("mode")
  const mode = rawMode !== undefined && isCrispMode(rawMode) ? rawMode : "shadow"
  const trigger = value("triggerSegment") ?? "triage"
  const llmMissing = settings.data !== undefined && integrations.find((i) => i.id === "openrouter")?.configured !== true
  const notesRefused = items.some((item) => item.outcome?.crisp.notePosted === false)

  const tiles = [
    { key: undefined, label: "All triaged", count: stats.data?.total },
    ...CRISP_DECISIONS.map((key) => ({ key, label: DECISION_VIEW[key].label, count: stats.data?.byDecision[key] })),
  ] as const

  return (
    <>
      <PageHeader title="Crisp" description="How incoming support conversations were triaged, and what came of each one.">
        <Button variant="outline" nativeButton={false} render={<Link to="/integrations/$id" params={{ id: "crisp" }} />}>
          <GearIcon />
          Settings
        </Button>
      </PageHeader>

      {llmMissing && (
        <Alert>
          <WarningCircleIcon />
          <AlertTitle>Nothing is triaged yet</AlertTitle>
          <AlertDescription>
            Crisp conversations are received, but the OpenRouter API key is not set, so they are not classified.{" "}
            <Link to="/integrations/$id" params={{ id: "openrouter" }} className="underline underline-offset-4">
              Set it up
            </Link>
          </AlertDescription>
        </Alert>
      )}

      <p className="text-sm text-muted-foreground">
        {MODE_COPY[mode]} Add the segment{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">{trigger}</code> to a conversation in Crisp to triage it. Last{" "}
        {stats.data?.windowDays ?? 30} days.
      </p>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {tiles.map((tile) => {
          const active = filters.decision === tile.key
          return (
            <button
              key={tile.label}
              type="button"
              aria-pressed={active}
              onClick={() => update({ decision: tile.key })}
              className="rounded-lg text-left focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Card size="sm" className={cn("h-full transition-colors hover:bg-muted/40", active && "ring-2 ring-primary")}>
                <CardHeader>
                  <CardDescription>{tile.label}</CardDescription>
                  {tile.count === undefined ? (
                    <Skeleton className="h-8 w-12" />
                  ) : (
                    <CardTitle className="text-2xl tabular-nums">{tile.count}</CardTitle>
                  )}
                </CardHeader>
              </Card>
            </button>
          )
        })}
      </div>

      {notesRefused && (
        <Alert>
          <WarningCircleIcon />
          <AlertTitle>Crisp does not accept private notes on this plan</AlertTitle>
          <AlertDescription>
            The status segment is still set on each conversation. The note that would have been posted is shown in the details of each conversation.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          value={[filters.unread ? "unread" : "all"]}
          onValueChange={(next) => next[0] && update({ unread: next[0] === "unread" ? true : undefined })}
          variant="outline"
          aria-label="Show"
        >
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="unread">Unread{stats.data ? ` (${stats.data.unread})` : ""}</ToggleGroupItem>
        </ToggleGroup>
        <TextFilter label="Search" value={filters.q} onChange={(q) => update({ q })} className="w-64" />
        {filters.decision && (
          <Button variant="ghost" size="sm" onClick={() => update({ decision: undefined })}>
            Clear filter: {DECISION_VIEW[filters.decision].label}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={!stats.data?.unread || readAll.isPending}
          onClick={() => readAll.mutate()}
        >
          <ChecksIcon />
          Mark all as read
        </Button>
      </div>

      {list.error ? (
        <QueryError error={list.error} onRetry={() => list.refetch()} />
      ) : list.isPending ? (
        <RowsSkeleton rows={4} />
      ) : items.length === 0 ? (
        <EmptyState
          title={filters.decision || filters.q ? "Nothing matches these filters" : "No conversations triaged yet"}
          hint={`In Crisp, open a conversation and add the segment "${trigger}". The result appears here within seconds.`}
        />
      ) : (
        <>
          <ul className="divide-y overflow-hidden rounded-lg border">
            {items.map((item) => (
              <CrispRow key={item.id} item={item} selected={current?.id === item.id} onOpen={() => open(item)} />
            ))}
          </ul>
          {list.hasNextPage && (
            <Button variant="outline" className="self-center" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
              {list.isFetchingNextPage ? "Loading..." : "Load more"}
            </Button>
          )}
        </>
      )}
      <CrispPanel
        item={current}
        onClose={() => setOpened(null)}
        busy={setRead.isPending}
        onToggleRead={(item) => setRead.mutate({ item, read: !item.read })}
      />
    </>
  )
}

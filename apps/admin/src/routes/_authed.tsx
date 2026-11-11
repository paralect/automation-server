import { useMemo, useState } from "react"
import { Link, Outlet, createFileRoute, redirect, useNavigate, useRouterState } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { AppSidebar } from "@/components/app-sidebar"
import { ThemeToggle } from "@/components/theme-toggle"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Separator } from "@/components/ui/separator"
import { QueryError } from "@/components/states"
import { Skeleton } from "@/components/ui/skeleton"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { selectProject } from "@/lib/api.functions"
import { getSessionFn } from "@/lib/auth.functions"
import { ProjectContext } from "@/lib/project"
import { projectsQuery } from "@/lib/queries"

export const Route = createFileRoute("/_authed")({
  beforeLoad: async () => {
    const session = await getSessionFn()
    if (!session) throw redirect({ to: "/login" })
    return { session }
  },
  component: AuthedLayout,
})

const TITLES: Record<string, string> = {
  "/": "Overview",
  "/logs": "Logs",
  "/runs": "Runs",
  "/actions": "GitHub Actions",
  "/integrations": "Integrations",
  "/workflows": "Workflows",
  "/system": "System",
  "/project": "Project settings",
}

const DETAIL_PARENTS: Record<string, "/actions" | "/runs" | "/integrations"> = {
  actions: "/actions",
  runs: "/runs",
  integrations: "/integrations",
}

const INTEGRATION_TITLES: Record<string, string> = { github: "GitHub", sentry: "Sentry", linear: "Linear", posthog: "PostHog" }

function Crumbs() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const [section, id] = pathname.split("/").filter(Boolean)
  const root = TITLES[`/${section ?? ""}`] ?? "Admin"

  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          {id ? (
            <BreadcrumbLink render={<Link to={DETAIL_PARENTS[section ?? ""] ?? "/"} />}>{root}</BreadcrumbLink>
          ) : (
            <BreadcrumbPage>{root}</BreadcrumbPage>
          )}
        </BreadcrumbItem>
        {id && (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              {section === "integrations" ? (
                <BreadcrumbPage>{INTEGRATION_TITLES[id] ?? id}</BreadcrumbPage>
              ) : (
                <BreadcrumbPage className="font-mono text-xs">{id.slice(0, 12)}</BreadcrumbPage>
              )}
            </BreadcrumbItem>
          </>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  )
}

function AuthedLayout() {
  const { session } = Route.useRouteContext()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const navigate = useNavigate()
  const projects = useQuery(projectsQuery())
  // Starts from the cookie. A deleted or unknown project falls back to the first one.
  const [selected, setSelected] = useState(session.project)

  const list = projects.data
  const project = list?.find((p) => p.id === selected) ?? list?.[0]

  const context = useMemo(() => {
    if (!list || !project) return null
    return {
      project,
      projects: list,
      select(id: string) {
        if (id === project.id) return
        setSelected(id)
        void selectProject({ data: { project: id } })
        // A run or an Actions run belongs to the project it was opened in.
        const [section, detail] = pathname.split("/").filter(Boolean)
        if (detail && section === "runs") void navigate({ to: "/runs" })
        if (detail && section === "actions") void navigate({ to: "/actions" })
      },
    }
  }, [list, project, pathname, navigate])

  return (
    <ProjectContext.Provider value={context}>
      <SidebarProvider>
        <AppSidebar user={session} projectsReady={context !== null} />
      <SidebarInset className="min-w-0">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-auto" />
          <Crumbs />
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </header>
        <div className="flex min-w-0 flex-1 flex-col gap-4 p-4 md:p-6">
          {context ? (
            // Remount the page on a project switch so local state (forms, open dialogs) never carries over.
            <Outlet key={context.project.id} />
          ) : projects.error ? (
            <QueryError error={projects.error} onRetry={() => projects.refetch()} />
          ) : (
            <Skeleton className="h-48 w-full" />
          )}
        </div>
      </SidebarInset>
      </SidebarProvider>
    </ProjectContext.Provider>
  )
}

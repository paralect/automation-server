import { Link, Outlet, createFileRoute, redirect, useRouterState } from "@tanstack/react-router"

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
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { getSessionFn } from "@/lib/auth.functions"

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
  "/system": "System",
}

function Crumbs() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const [section, id] = pathname.split("/").filter(Boolean)
  const root = TITLES[`/${section ?? ""}`] ?? "Admin"

  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          {id ? (
            <BreadcrumbLink render={<Link to={section === "actions" ? "/actions" : "/runs"} />}>{root}</BreadcrumbLink>
          ) : (
            <BreadcrumbPage>{root}</BreadcrumbPage>
          )}
        </BreadcrumbItem>
        {id && (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage className="font-mono text-xs">{id.slice(0, 12)}</BreadcrumbPage>
            </BreadcrumbItem>
          </>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  )
}

function AuthedLayout() {
  const { session } = Route.useRouteContext()

  return (
    <SidebarProvider>
      <AppSidebar user={session} />
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
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

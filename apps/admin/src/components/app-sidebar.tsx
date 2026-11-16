import * as React from "react"
import { Link, useRouterState } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  GaugeIcon,
  GithubLogoIcon,
  HeartbeatIcon,
  LightningIcon,
  ListChecksIcon,
  PlugsConnectedIcon,
  TreeStructureIcon,
  ScrollIcon,
} from "@phosphor-icons/react"

import { CrispIcon } from "@/components/crisp-triage"
import { isAdded } from "@/components/integration-card"
import { NavUser } from "@/components/nav-user"
import { ProjectSwitcher, ProjectSwitcherSkeleton } from "@/components/project-switcher"
import { useProjectId } from "@/lib/project"
import { crispStatsQuery, settingsQuery } from "@/lib/queries"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenuBadge,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"

const NAV = [
  { title: "Overview", to: "/", icon: GaugeIcon },
  { title: "Setup", to: "/setup", icon: ListChecksIcon },
  { title: "Integrations", to: "/integrations", icon: PlugsConnectedIcon },
  { title: "Logs", to: "/logs", icon: ScrollIcon },
  { title: "Runs", to: "/runs", icon: LightningIcon },
  { title: "GitHub Actions", to: "/actions", icon: GithubLogoIcon },
  { title: "Workflows", to: "/workflows", icon: TreeStructureIcon },
  { title: "System", to: "/system", icon: HeartbeatIcon },
] as const

/**
 * Pages that exist only for an integration the project added. They sit under one "Support" heading, so a
 * future support integration adds a line here and shows up in the same place.
 */
const SUPPORT_NAV = [{ integration: "crisp", title: "Crisp", to: "/crisp", icon: CrispIcon }] as const

function SupportNav({ pathname }: { pathname: string }) {
  const project = useProjectId()
  const settings = useQuery(settingsQuery(project))
  const added = new Set((settings.data?.integrations ?? []).filter(isAdded).map((i) => i.id as string))
  const items = SUPPORT_NAV.filter((item) => added.has(item.integration))
  const crispStats = useQuery({ ...crispStatsQuery(project), enabled: added.has("crisp") })
  const unread: Record<string, number> = { crisp: crispStats.data?.unread ?? 0 }
  if (items.length === 0) return null

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Support</SidebarGroupLabel>
      <SidebarMenu>
        {items.map(({ integration, title, to, icon: Icon }) => (
          <SidebarMenuItem key={to}>
            <SidebarMenuButton tooltip={title} isActive={pathname.startsWith(to)} render={<Link to={to} />}>
              <Icon />
              <span>{title}</span>
            </SidebarMenuButton>
            {(unread[integration] ?? 0) > 0 && <SidebarMenuBadge aria-label={`${unread[integration]} unread`}>{unread[integration]}</SidebarMenuBadge>}
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}

export function AppSidebar({
  user,
  projectsReady,
  ...props
}: React.ComponentProps<typeof Sidebar> & { user: { email: string }; projectsReady: boolean }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link to="/" />}>
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <LightningIcon />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">Automation Server</span>
                <span className="truncate text-xs">Admin</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {projectsReady ? <ProjectSwitcher /> : <ProjectSwitcherSkeleton />}
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {NAV.map(({ title, to, icon: Icon }) => (
              <SidebarMenuItem key={to}>
                <SidebarMenuButton
                  tooltip={title}
                  isActive={to === "/" ? pathname === "/" : pathname.startsWith(to)}
                  render={<Link to={to} />}
                >
                  <Icon />
                  <span>{title}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
        {projectsReady && <SupportNav pathname={pathname} />}
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

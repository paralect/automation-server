import { useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { CaretUpDownIcon, GearSixIcon, PlusIcon } from "@phosphor-icons/react"
import { cn } from "cn"

import { ProjectFields, type ProjectFormValues } from "@/components/project-form"
import { ProjectIcon } from "@/components/project-icon"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { createProject, type Project } from "@/lib/api.functions"
import { errorText } from "@/lib/errors"
import { useProjects } from "@/lib/project"
import { projectsQuery } from "@/lib/queries"

export function ProjectSwitcher() {
  const { project, projects, select } = useProjects()
  const navigate = useNavigate()
  const [adding, setAdding] = useState(false)

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                tooltip={project.name}
                className="ring-1 ring-sidebar-border aria-expanded:bg-sidebar-accent group-data-[collapsible=icon]:ring-0"
              />
            }
          >
            <ProjectIcon project={project} />
            <span className="flex-1 truncate font-medium">{project.name}</span>
            <CaretUpDownIcon className="ml-auto size-4 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-60"
            side="bottom"
            align="start"
            sideOffset={6}
          >
            <DropdownMenuGroup>
              {projects.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  onClick={() => select(p.id)}
                  aria-current={p.id === project.id || undefined}
                  className={cn(
                    "gap-2.5 py-2",
                    p.id === project.id && "bg-accent text-accent-foreground"
                  )}
                >
                  <ProjectIcon project={p} />
                  <span className="truncate">{p.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="gap-2.5 py-2" onClick={() => setAdding(true)}>
              <PlusIcon />
              Add project
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2.5 py-2" onClick={() => void navigate({ to: "/project" })}>
              <GearSixIcon />
              Project settings
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <AddProjectDialog
          open={adding}
          onOpenChange={setAdding}
          onCreated={(p) => {
            select(p.id)
            void navigate({ to: "/setup" })
          }}
        />
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

export function ProjectSwitcherSkeleton() {
  return <Skeleton className="h-12 w-full rounded-lg" />
}

function AddProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (project: Project) => void
}) {
  const queryClient = useQueryClient()
  const [values, setValues] = useState<ProjectFormValues>({ name: "", domain: "" })
  const create = useMutation({
    mutationFn: () => createProject({ data: { name: values.name, domain: values.domain || null } }),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: projectsQuery().queryKey })
      onCreated(project)
      close(false)
    },
  })

  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setValues({ name: "", domain: "" })
      create.reset()
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            create.mutate()
          }}
          className="contents"
        >
          <DialogHeader>
            <DialogTitle>Add project</DialogTitle>
            <DialogDescription>
              A project has its own integrations, repositories, webhook URLs, runs and logs. A setup guide opens next.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <ProjectFields
              id="new-project"
              autoFocus
              values={values}
              onChange={setValues}
              error={create.error ? errorText(create.error) : undefined}
            />
          </DialogBody>
          <DialogFooter className="flex-row justify-end">
            <Button type="button" variant="outline" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || values.name.trim() === ""}>
              {create.isPending ? "Creating…" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

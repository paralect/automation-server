import { useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { TrashIcon } from "@phosphor-icons/react"

import { ProjectFields, type ProjectFormValues } from "@/components/project-form"
import { PageHeader } from "@/components/states"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { deleteProject, updateProject, type Project } from "@/lib/api.functions"
import { errorText } from "@/lib/errors"
import { useProjects } from "@/lib/project"
import { projectsQuery } from "@/lib/queries"

export const Route = createFileRoute("/_authed/project")({ component: ProjectSettings })

// Mirrors DEFAULT_PROJECT_ID on the server, which refuses to delete it.
const DEFAULT_PROJECT_ID = "default"

function ProjectSettings() {
  const { project } = useProjects()

  return (
    <>
      <PageHeader
        title="Project settings"
        description="Integrations, repositories, webhooks, runs and logs all belong to the selected project."
      />
      <GeneralCard project={project} />
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Project ID</CardTitle>
          <CardDescription>
            Part of this project's webhook URLs, such as <code className="font-mono">/webhooks/{project.id}/sentry</code>.
            It never changes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Input value={project.id} readOnly className="max-w-xs font-mono" onFocus={(e) => e.target.select()} />
        </CardContent>
      </Card>
      {project.id === DEFAULT_PROJECT_ID ? (
        <p className="max-w-2xl text-xs text-muted-foreground">
          This is the default project. It also reads integration settings from the server environment and answers the
          older webhook URLs without a project, such as /webhooks/sentry, so it cannot be deleted.
        </p>
      ) : (
        <DeleteCard project={project} />
      )}
    </>
  )
}

function GeneralCard({ project }: { project: Project }) {
  const queryClient = useQueryClient()
  const [values, setValues] = useState<ProjectFormValues>({ name: project.name, domain: project.domain ?? "" })
  const save = useMutation({
    mutationFn: () => updateProject({ data: { id: project.id, name: values.name, domain: values.domain || null } }),
    onSuccess: (updated) => {
      queryClient.setQueryData(projectsQuery().queryKey, (list) => list?.map((p) => (p.id === updated.id ? updated : p)))
      setValues({ name: updated.name, domain: updated.domain ?? "" })
    },
  })
  const dirty = values.name !== project.name || values.domain !== (project.domain ?? "")

  return (
    <Card className="max-w-2xl">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
        className="contents"
      >
        <CardHeader>
          <CardTitle>General</CardTitle>
        </CardHeader>
        <CardContent>
          <ProjectFields
            id="project"
            values={values}
            onChange={setValues}
            error={save.error ? errorText(save.error) : undefined}
          />
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" disabled={!dirty || save.isPending || values.name.trim() === ""}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}

function DeleteCard({ project }: { project: Project }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { select } = useProjects()
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState("")
  const remove = useMutation({
    mutationFn: () => deleteProject({ data: { id: project.id } }),
    onSuccess: async () => {
      setOpen(false)
      select(DEFAULT_PROJECT_ID)
      await queryClient.invalidateQueries({ queryKey: projectsQuery().queryKey })
      queryClient.removeQueries({ queryKey: [project.id] })
      await navigate({ to: "/" })
    },
  })

  return (
    <Card className="max-w-2xl ring-destructive/30">
      <CardHeader>
        <CardTitle>Delete project</CardTitle>
        <CardDescription>
          Removes the project and all of its integration settings. Its webhook URLs stop answering. Past runs and logs
          stay until retention prunes them.
        </CardDescription>
      </CardHeader>
      <CardFooter className="justify-end">
        <Button variant="destructive" onClick={() => setOpen(true)}>
          <TrashIcon />
          Delete project
        </Button>
      </CardFooter>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) {
            setConfirm("")
            remove.reset()
          }
        }}
      >
        <DialogContent>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              remove.mutate()
            }}
            className="contents"
          >
            <DialogHeader>
              <DialogTitle>Delete {project.name}?</DialogTitle>
              <DialogDescription>
                This cannot be undone. Type <span className="font-mono text-foreground">{project.id}</span> to confirm.
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="flex flex-col gap-2">
              <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoFocus aria-label="Project ID" />
              {remove.error && <FieldError>{errorText(remove.error)}</FieldError>}
            </DialogBody>
            <DialogFooter className="flex-row justify-end">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={confirm !== project.id || remove.isPending}>
                {remove.isPending ? "Deleting…" : "Delete project"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

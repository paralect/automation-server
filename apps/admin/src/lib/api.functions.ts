import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import type { IntegrationView } from "@automation-server/api/routers/index"

export type {
  IntegrationLink,
  InstallMode,
  InstallOutcome,
  InstallResult,
  PosthogPreview,
  PosthogRunResult,
  Project,
  PullRequestRef,
  TemplateState,
  TemplateStatus,
  WorkflowCheck,
  WorkflowStatus,
  WorkflowTemplateInfo,
} from "@automation-server/api/routers/index"

import { callAutomation } from "@/server/automation-client.server"
import { rememberProject } from "@/server/project.server"
import { requireAuth } from "./auth.middleware"
import { actionRunInput, actionsInput, logsInput, runsInput, WINDOWS, windowInput } from "./filters"

const authed = createServerFn({ method: "GET", strict: { input: true, output: false } }).middleware([requireAuth])
const authedPost = createServerFn({ method: "POST", strict: { input: true, output: false } }).middleware([requireAuth])

const projectId = z.string().min(1).max(64)
/** Every project-scoped call names its project, so cached data of one project never shows under another. */
const inProject = z.object({ project: projectId })

export const listProjects = authed.handler(() => callAutomation((api) => api.projects.list()))

const projectFields = { name: z.string().max(200), domain: z.string().max(300).nullable() }

export const createProject = authedPost
  .validator(z.object(projectFields))
  .handler(({ data }) => callAutomation((api) => api.projects.create(data)))

export const updateProject = authedPost
  .validator(z.object({ id: projectId, ...projectFields }))
  .handler(({ data }) => callAutomation((api) => api.projects.update(data)))

export const deleteProject = authedPost
  .validator(z.object({ id: projectId }))
  .handler(({ data }) => callAutomation((api) => api.projects.delete(data)))

/** Remembers the selected project in a cookie, so the admin opens on it next time. */
export const selectProject = authedPost.validator(inProject).handler(({ data }) => rememberProject(data.project))

export const getOverview = authed
  .validator(inProject.extend(windowInput.shape))
  .handler(({ data }) =>
    callAutomation((api) => api.overview({ project: data.project, windowHours: WINDOWS[data.window] }))
  )

export const listLogs = authed.validator(inProject.extend(logsInput.shape)).handler(({ data: { q, ...rest } }) =>
  callAutomation((api) => api.logs.list({ ...rest, search: q }))
)

export const listRuns = authed.validator(inProject.extend(runsInput.shape)).handler(({ data: { q, ...rest } }) =>
  callAutomation((api) => api.runs.list({ ...rest, search: q }))
)

export const getRun = authed
  .validator(inProject.extend({ id: z.string().min(1) }))
  .handler(({ data }) =>
    callAutomation((api) => api.runs.get(data), { notFoundIsExpected: true })
  )

export const getSystem = authed.validator(inProject).handler(({ data }) => callAutomation((api) => api.system(data)))

export const listActionRuns = authed.validator(inProject.extend(actionsInput.shape)).handler(({ data }) =>
  callAutomation((api) => api.actions.list(data))
)

export const getActionRun = authed.validator(inProject.extend(actionRunInput.shape)).handler(({ data }) =>
  callAutomation((api) => api.actions.get(data), { notFoundIsExpected: true })
)

type IntegrationId = IntegrationView["id"]
const integrationInput = inProject.extend({ integrationId: z.string().min(1).max(64) })

export const getSettings = authed.validator(inProject).handler(({ data }) => callAutomation((api) => api.settings.get(data)))

export const updateSettings = authedPost
  .validator(
    integrationInput.extend({
      values: z.record(z.string(), z.unknown()),
      clear: z.array(z.string().max(64)).max(64),
    })
  )
  .handler(({ data }) =>
    callAutomation((api) =>
      api.settings.update({ ...data, integrationId: data.integrationId as IntegrationId })
    )
  )

export const testConnection = authedPost.validator(integrationInput).handler(({ data }) =>
  callAutomation((api) =>
    api.settings.testConnection({ project: data.project, integrationId: data.integrationId as IntegrationId })
  )
)

export const previewPosthogReport = authedPost
  .validator(inProject)
  .handler(({ data }) => callAutomation((api) => api.posthog.preview(data)))

export const runPosthogNow = authedPost
  .validator(inProject)
  .handler(({ data }) => callAutomation((api) => api.posthog.runNow(data)))

export const listWorkflowTemplates = authed.handler(() =>
  callAutomation((api) => api.workflows.templates(), { showMessages: true })
)

const repoInput = inProject.extend({ repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) })

export const getWorkflowStatus = authed.validator(repoInput).handler(({ data }) =>
  callAutomation((api) => api.workflows.status(data), { showMessages: true })
)

export const checkWorkflow = authed.validator(repoInput.extend({ templateId: z.string().min(1).max(100) })).handler(({ data }) =>
  callAutomation((api) => api.workflows.check(data), { showMessages: true })
)

export const installWorkflow = authedPost
  .validator(repoInput.extend({ templateId: z.string().min(1).max(100), mode: z.enum(["pr", "direct"]) }))
  .handler(({ data }) => callAutomation((api) => api.workflows.install(data), { showMessages: true }))

import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import type { IntegrationView } from "@automation-server/api/routers/index"

export type {
  InstallMode,
  InstallOutcome,
  InstallResult,
  PosthogPreview,
  PosthogRunResult,
  PullRequestRef,
  TemplateState,
  TemplateStatus,
  WorkflowStatus,
  WorkflowTemplateInfo,
} from "@automation-server/api/routers/index"

import { callAutomation } from "@/server/automation-client.server"
import { requireAuth } from "./auth.middleware"
import { actionRunInput, actionsInput, logsInput, runsInput, WINDOWS, windowInput } from "./filters"

const authed = createServerFn({ method: "GET", strict: { input: true, output: false } }).middleware([requireAuth])
const authedPost = createServerFn({ method: "POST", strict: { input: true, output: false } }).middleware([requireAuth])

export const getOverview = authed
  .validator(windowInput)
  .handler(({ data }) =>
    callAutomation((api) => api.overview({ windowHours: WINDOWS[data.window] }))
  )

export const listLogs = authed.validator(logsInput).handler(({ data: { q, ...rest } }) =>
  callAutomation((api) => api.logs.list({ ...rest, search: q }))
)

export const listRuns = authed.validator(runsInput).handler(({ data: { q, ...rest } }) =>
  callAutomation((api) => api.runs.list({ ...rest, search: q }))
)

export const getRun = authed
  .validator(z.object({ id: z.string().min(1) }))
  .handler(({ data }) =>
    callAutomation((api) => api.runs.get(data), { notFoundIsExpected: true })
  )

export const getSystem = authed.handler(() => callAutomation((api) => api.system()))

export const listActionRuns = authed.validator(actionsInput).handler(({ data }) =>
  callAutomation((api) => api.actions.list(data))
)

export const getActionRun = authed.validator(actionRunInput).handler(({ data }) =>
  callAutomation((api) => api.actions.get(data), { notFoundIsExpected: true })
)

type IntegrationId = IntegrationView["id"]
const integrationInput = z.object({ integrationId: z.string().min(1).max(64) })

export const getSettings = authed.handler(() => callAutomation((api) => api.settings.get()))

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
  callAutomation((api) => api.settings.testConnection({ integrationId: data.integrationId as IntegrationId }))
)

export const previewPosthogReport = authedPost.handler(() => callAutomation((api) => api.posthog.preview()))

export const runPosthogNow = authedPost.handler(() => callAutomation((api) => api.posthog.runNow()))

export const listWorkflowTemplates = authed.handler(() =>
  callAutomation((api) => api.workflows.templates(), { showMessages: true })
)

const repoInput = z.object({ repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) })

export const getWorkflowStatus = authed.validator(repoInput).handler(({ data }) =>
  callAutomation((api) => api.workflows.status(data), { showMessages: true })
)

export const installWorkflow = authedPost
  .validator(repoInput.extend({ templateId: z.string().min(1).max(100), mode: z.enum(["pr", "direct"]) }))
  .handler(({ data }) => callAutomation((api) => api.workflows.install(data), { showMessages: true }))

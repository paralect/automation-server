import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import type { AppRouterClient, IntegrationView } from "@automation-server/api/routers/index"

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

export type InstallMode = "pr" | "direct"
export type PullRequestRef = { number: number; url: string }
export type WorkflowTemplateInfo = {
  id: string
  title: string
  description: string
  path: string
  files: string[]
  /** Each entry is satisfied by any one of its names. */
  requiredSecrets: string[][]
  requiredVariables: string[]
}
export type TemplateState = "installed" | "differs" | "missing"
export type TemplateStatus = {
  templateId: string
  state: TemplateState
  changedFiles: string[]
  pullRequest: PullRequestRef | null
}
export type WorkflowStatus = { repo: string; defaultBranch: string; templates: TemplateStatus[] }
export type InstallOutcome = "already-installed" | "committed" | "pr-opened" | "pr-exists"
export type InstallResult = {
  repo: string
  templateId: string
  mode: InstallMode
  outcome: InstallOutcome
  branch: string
  filesWritten: string[]
  pullRequest: PullRequestRef | null
}
export type PosthogPreview = { ok: true; text: string; generatedAt: string } | { ok: false; message: string }
export type PosthogRunResult =
  | { status: "succeeded" | "failed"; runId: string | null; key: string; message: string }
  | { status: "busy" | "not-configured"; message: string }

/**
 * Routes built on the posthog and workflow-install branches, declared here until they merge into
 * AppRouterClient. Remove this type and `pending` once the router has them.
 */
type PendingRoutes = {
  posthog: {
    preview(): Promise<PosthogPreview>
    runNow(): Promise<PosthogRunResult>
  }
  workflows: {
    templates(): Promise<WorkflowTemplateInfo[]>
    status(input: { repo: string }): Promise<WorkflowStatus>
    install(input: { repo: string; templateId: string; mode?: InstallMode }): Promise<InstallResult>
  }
}
const pending = (api: AppRouterClient) => api as AppRouterClient & PendingRoutes

export const previewPosthogReport = authedPost.handler(() => callAutomation((api) => pending(api).posthog.preview()))

export const runPosthogNow = authedPost.handler(() => callAutomation((api) => pending(api).posthog.runNow()))

export const listWorkflowTemplates = authed.handler(() =>
  callAutomation((api) => pending(api).workflows.templates(), { showMessages: true })
)

const repoInput = z.object({ repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) })

export const getWorkflowStatus = authed.validator(repoInput).handler(({ data }) =>
  callAutomation((api) => pending(api).workflows.status(data), { showMessages: true })
)

export const installWorkflow = authedPost
  .validator(repoInput.extend({ templateId: z.string().min(1).max(100), mode: z.enum(["pr", "direct"]) }))
  .handler(({ data }) => callAutomation((api) => pending(api).workflows.install(data), { showMessages: true }))

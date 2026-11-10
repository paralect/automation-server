import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import { callAutomation } from "@/server/automation-client.server"
import { requireAuth } from "./auth.middleware"
import { actionRunInput, actionsInput, logsInput, runsInput, WINDOWS, windowInput } from "./filters"

const authed = createServerFn({ method: "GET", strict: { input: true, output: false } }).middleware([requireAuth])

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

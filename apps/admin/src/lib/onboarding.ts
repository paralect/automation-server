import type { IntegrationView } from "@automation-server/api/routers/index"

import type { TemplateState, WorkflowTemplateInfo } from "./api.functions"
import { fieldOf, savedRepo, templateFor, type LinkedTemplate } from "./integration-workflows"

export type StepId = "token" | "repository" | "services" | "workflows"
/** `idle` is a step with nothing to do yet, such as workflows before any service that needs one is connected. */
export type StepStatus = "done" | "todo" | "idle"

export const SERVICE_IDS = ["sentry", "linear", "posthog"] as const

/** A workflow the project needs: a connected service whose bundled workflow has a repository to live in. */
export type NeededWorkflow = { readonly integration: IntegrationView; readonly template: LinkedTemplate; readonly repo: string | undefined }

export function neededWorkflows(
  integrations: readonly IntegrationView[],
  templates: readonly WorkflowTemplateInfo[] | undefined,
): NeededWorkflow[] {
  return integrations.flatMap((integration) => {
    const template = integration.configured ? templateFor(integration.id, templates) : undefined
    return template ? [{ integration, template, repo: savedRepo(template, integrations) }] : []
  })
}

/**
 * Where a project stands, one status per step. `workflowStates` holds the checked state of each needed
 * workflow by template id. A workflow that has not been checked yet keeps its step open.
 */
export function stepStatuses(
  integrations: readonly IntegrationView[],
  needed: readonly NeededWorkflow[],
  workflowStates: ReadonlyMap<string, TemplateState>,
): Record<StepId, StepStatus> {
  const token = fieldOf(integrations, "github", "token")?.set === true
  const repo = fieldOf(integrations, "github", "repo")?.value
  const services = integrations.some((i) => (SERVICE_IDS as readonly string[]).includes(i.id) && i.configured)
  return {
    token: token ? "done" : "todo",
    repository: typeof repo === "string" && repo.length > 0 ? "done" : "todo",
    services: services ? "done" : "todo",
    workflows:
      needed.length === 0
        ? "idle"
        : needed.every((n) => workflowStates.get(n.template.id) === "installed")
          ? "done"
          : "todo",
  }
}

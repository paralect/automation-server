import type { IntegrationView } from "@automation-server/api/routers/index"

import type { WorkflowTemplateInfo } from "./api.functions"

export const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export type LinkedTemplate = WorkflowTemplateInfo & { integration: NonNullable<WorkflowTemplateInfo["integration"]> }

/** The bundled workflow an integration relies on, if any. */
export function templateFor(integrationId: string, templates: readonly WorkflowTemplateInfo[] | undefined): LinkedTemplate | undefined {
  return templates?.find((t): t is LinkedTemplate => t.integration?.integration === integrationId)
}

export function fieldOf(integrations: readonly IntegrationView[], integrationId: string, key: string) {
  return integrations.find((i) => i.id === integrationId)?.fields.find((f) => f.key === key)
}

/** The saved repository the workflow belongs in, or undefined while it is not set to an owner/name. */
export function savedRepo(template: LinkedTemplate, integrations: readonly IntegrationView[]): string | undefined {
  const { integration, key } = template.integration.repoSetting
  const value = fieldOf(integrations, integration, key)?.value
  return typeof value === "string" && REPO_RE.test(value.trim()) ? value.trim() : undefined
}

export const isGithubReady = (integrations: readonly IntegrationView[]) =>
  integrations.find((i) => i.id === "github")?.configured === true

export const secretsUrl = (repo: string) => `https://github.com/${repo}/settings/secrets/actions`
export const actionsSettingsUrl = (repo: string) => `https://github.com/${repo}/settings/actions`

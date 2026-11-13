import { describe, expect, test } from "bun:test"
import type { FieldView, IntegrationView } from "@automation-server/api/routers/index"

import type { WorkflowTemplateInfo } from "./api.functions"
import { neededWorkflows, stepStatuses } from "./onboarding"

const field = (key: string, over: Partial<FieldView> = {}): FieldView => ({
  key,
  label: key,
  kind: "text",
  required: false,
  source: "default",
  set: false,
  ...over,
})

const integration = (id: IntegrationView["id"], configured: boolean, fields: FieldView[]): IntegrationView => ({
  id,
  title: id,
  description: "",
  configured,
  missing: [],
  fields,
})

const template = (id: string, link: WorkflowTemplateInfo["integration"]): WorkflowTemplateInfo => ({
  id,
  title: id,
  description: "",
  path: `.github/workflows/${id}.yml`,
  files: [],
  requiredSecrets: [["CODEX_AUTH_JSON"]],
  requiredVariables: [],
  integration: link,
})

const TEMPLATES = [
  template("codex-issue-fix", { integration: "sentry", required: false, repoSetting: { integration: "github", key: "repo" } }),
  template("linear-implement", { integration: "linear", required: true, repoSetting: { integration: "linear", key: "targetRepo" } }),
  template("codex-changelog", null),
]

const fresh = [
  integration("github", false, [field("token", { kind: "secret" }), field("repo")]),
  integration("sentry", false, []),
  integration("linear", false, [field("targetRepo")]),
  integration("posthog", false, []),
]

describe("onboarding steps", () => {
  test("a new project has every step open and no workflow to install yet", () => {
    const needed = neededWorkflows(fresh, TEMPLATES)
    expect(needed).toEqual([])
    expect(stepStatuses(fresh, needed, new Map())).toEqual({ token: "todo", repository: "todo", services: "todo", workflows: "idle" })
  })

  test("a connected service needs its workflow in the repository its setting names, until the check says installed", () => {
    const setUp = [
      integration("github", true, [field("token", { kind: "secret", set: true }), field("repo", { value: "acme/issues" })]),
      integration("sentry", false, []),
      integration("linear", true, [field("targetRepo", { value: "acme/app" })]),
      integration("posthog", false, []),
    ]
    const needed = neededWorkflows(setUp, TEMPLATES)
    expect(needed.map((n) => [n.template.id, n.repo])).toEqual([["linear-implement", "acme/app"]])

    expect(stepStatuses(setUp, needed, new Map())).toEqual({ token: "done", repository: "done", services: "done", workflows: "todo" })
    expect(stepStatuses(setUp, needed, new Map([["linear-implement", "differs"]])).workflows).toBe("todo")
    expect(stepStatuses(setUp, needed, new Map([["linear-implement", "installed"]])).workflows).toBe("done")
  })

  test("PostHog counts as a connected service but needs no workflow", () => {
    const withPosthog = fresh.map((i) => (i.id === "posthog" ? { ...i, configured: true } : i))
    const needed = neededWorkflows(withPosthog, TEMPLATES)
    expect(stepStatuses(withPosthog, needed, new Map())).toMatchObject({ services: "done", workflows: "idle" })
  })
})

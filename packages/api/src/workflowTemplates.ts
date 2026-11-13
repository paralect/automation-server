import type { IntegrationId } from "@automation-server/settings";

import { WORKFLOW_SOURCES } from "./workflowTemplates.generated";

export type TemplateFile = { readonly path: string; readonly content: string };

/** Ties a workflow to the integration that relies on it, so setting that integration up can check for and install it. */
export type IntegrationLink = {
  readonly integration: IntegrationId;
  /** `true` when the integration does nothing useful without the workflow. `false` when it only adds to it. */
  readonly required: boolean;
  /** The setting that names the repository the workflow belongs in. It can live on another integration. */
  readonly repoSetting: { readonly integration: IntegrationId; readonly key: string };
};

export type WorkflowTemplate = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Workflow file inside the target repository. */
  readonly path: string;
  /** Every file the install commits, the workflow first. */
  readonly files: readonly TemplateFile[];
  /** Each entry is satisfied by any one of its secret names. */
  readonly requiredSecrets: readonly (readonly string[])[];
  readonly requiredVariables: readonly string[];
  readonly integration?: IntegrationLink;
};

type TemplateMeta = {
  readonly title: string;
  readonly description: string;
  /** Folder under github-actions/skills/ that the install copies to .agents/skills/. */
  readonly skill?: string;
  readonly requiredSecrets: readonly (readonly string[])[];
  readonly requiredVariables: readonly string[];
  readonly integration?: IntegrationLink;
};

const CODEX_AUTH = ["OPENAI_API_KEY", "CODEX_AUTH_JSON"] as const;

// Keyed by the file name in github-actions/. Every workflow file there needs an entry, buildTemplates throws otherwise.
// An entry whose file is not in github-actions/ yet is not offered, so metadata can land before its workflow.
export const TEMPLATE_META: Readonly<Record<string, TemplateMeta>> = {
  "codex-issue-fix.yml": {
    title: "Codex issue fix",
    description: "Opens a PR with a Codex-written fix for each new issue. Private repositories only.",
    skill: "fix-issue",
    requiredSecrets: [["CODEX_AUTH_JSON"]],
    requiredVariables: [],
    integration: { integration: "sentry", required: false, repoSetting: { integration: "github", key: "repo" } },
  },
  "codex-seo-autopilot.yml": {
    title: "Codex SEO autopilot",
    description: "Daily SEO run with Codex that opens one PR per run when something changes.",
    requiredSecrets: [CODEX_AUTH],
    requiredVariables: ["SEO_SITE", "SEO_PRODUCT", "SEO_CONVERSION"],
  },
  "codex-changelog.yml": {
    title: "Codex changelog",
    description: "On every push to the production branch, Codex writes a changelog note and opens a PR.",
    skill: "write-changelog",
    requiredSecrets: [CODEX_AUTH],
    requiredVariables: [],
  },
  "linear-implement.yml": {
    title: "Linear implement",
    description: "Implements a Linear issue with Codex when the server dispatches it, then opens a PR. Private repositories only.",
    skill: "implement-task",
    requiredSecrets: [["CODEX_AUTH_JSON"]],
    requiredVariables: [],
    integration: { integration: "linear", required: true, repoSetting: { integration: "linear", key: "targetRepo" } },
  },
};

const isWorkflow = (source: string) => !source.includes("/") && source.endsWith(".yml");

export function buildTemplates(
  sources: Readonly<Record<string, string>>,
  meta: Readonly<Record<string, TemplateMeta>> = TEMPLATE_META,
): WorkflowTemplate[] {
  return Object.keys(sources)
    .filter(isWorkflow)
    .sort()
    .map((file) => {
      const spec = meta[file];
      if (!spec) throw new Error(`github-actions/${file} has no entry in TEMPLATE_META (packages/api/src/workflowTemplates.ts)`);
      const path = `.github/workflows/${file}`;
      const skillPrefix = spec.skill ? `skills/${spec.skill}/` : undefined;
      const skillFiles = skillPrefix
        ? Object.keys(sources)
            .filter((key) => key.startsWith(skillPrefix))
            .sort()
            .map((key) => ({ path: `.agents/${key}`, content: sources[key] as string }))
        : [];
      if (skillPrefix && skillFiles.length === 0) {
        throw new Error(`github-actions/${file} ships the skill "${spec.skill}" but github-actions/${skillPrefix} is empty`);
      }
      return {
        id: file.slice(0, -".yml".length),
        title: spec.title,
        description: spec.description,
        path,
        files: [{ path, content: sources[file] as string }, ...skillFiles],
        requiredSecrets: spec.requiredSecrets,
        requiredVariables: spec.requiredVariables,
        ...(spec.integration ? { integration: spec.integration } : {}),
      };
    });
}

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = buildTemplates(WORKFLOW_SOURCES);

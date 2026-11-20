import { WORKFLOW_SOURCES } from "./workflowTemplates.generated";
const CODEX_AUTH = ["OPENAI_API_KEY", "CODEX_AUTH_JSON"];
export const TEMPLATE_META = {
    "codex-issue-fix.yml": {
        title: "Codex issue fix",
        description: "Opens a PR with a Codex-written fix for each new team issue, or for an issue the Crisp triage or a person dispatches. Sentry issues wait for a person to start them. Private repositories only.",
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
const isWorkflow = (source) => !source.includes("/") && source.endsWith(".yml");
export function buildTemplates(sources, meta = TEMPLATE_META) {
    return Object.keys(sources)
        .filter(isWorkflow)
        .sort()
        .map((file) => {
        const spec = meta[file];
        if (!spec)
            throw new Error(`github-actions/${file} has no entry in TEMPLATE_META (packages/api/src/workflowTemplates.ts)`);
        const path = `.github/workflows/${file}`;
        const skillPrefix = spec.skill ? `skills/${spec.skill}/` : undefined;
        const skillFiles = skillPrefix
            ? Object.keys(sources)
                .filter((key) => key.startsWith(skillPrefix))
                .sort()
                .map((key) => ({ path: `.agents/${key}`, content: sources[key] }))
            : [];
        if (skillPrefix && skillFiles.length === 0) {
            throw new Error(`github-actions/${file} ships the skill "${spec.skill}" but github-actions/${skillPrefix} is empty`);
        }
        return {
            id: file.slice(0, -".yml".length),
            title: spec.title,
            description: spec.description,
            path,
            files: [{ path, content: sources[file] }, ...skillFiles],
            requiredSecrets: spec.requiredSecrets,
            requiredVariables: spec.requiredVariables,
            ...(spec.integration ? { integration: spec.integration } : {}),
        };
    });
}
export const WORKFLOW_TEMPLATES = buildTemplates(WORKFLOW_SOURCES);

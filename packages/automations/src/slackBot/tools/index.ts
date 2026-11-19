import { createGithubClient } from "../../github";
import { createLinearClient } from "../../linear";
import type { PosthogReportConfig } from "../../posthogWeeklyReport/job";
import { githubTools, githubWriteTools } from "./github";
import { linearTools, linearWriteTools } from "./linear";
import { posthogTools } from "./posthog";
import { sentryTools } from "./sentry";
import type { AnyTool } from "./types";

export * from "./registry";
export { defineTool, type AnyTool, type Tool, type ToolContext, type ToolKind, type ToolResult } from "./types";

// An integration that is left out has no tools, so the model is never told it exists.
export type ReadToolsConfig = {
  readonly github?: { readonly token: string; readonly repo: { owner: string; name: string } };
  readonly sentry?: { readonly authToken: string; readonly apiBaseUrl: string };
  readonly posthog?: PosthogReportConfig;
  readonly linear?: { readonly apiKey: string };
  readonly fetch?: typeof fetch;
};

export function buildReadTools({ github, sentry, posthog, linear, fetch }: ReadToolsConfig): AnyTool[] {
  return [
    ...(github ? githubTools(createGithubClient({ repo: github.repo, token: github.token, fetch }), `${github.repo.owner}/${github.repo.name}`) : []),
    ...(sentry ? sentryTools({ ...sentry, fetch }) : []),
    ...(posthog ? posthogTools(posthog, { fetch }) : []),
    ...(linear ? linearTools(createLinearClient({ apiKey: linear.apiKey, fetch })) : []),
  ];
}

// Write tools are only built for an integration that is configured and that the project allowed the bot to change.
export type WriteToolsConfig = {
  readonly github?: { readonly token: string; readonly repo: { owner: string; name: string }; readonly workflowFiles: readonly string[]; readonly workflowRefs?: Readonly<Record<string, string>> };
  readonly linear?: { readonly apiKey: string; readonly triggerLabel?: string };
  readonly fetch?: typeof fetch;
};

export function buildWriteTools({ github, linear, fetch }: WriteToolsConfig): AnyTool[] {
  return [
    ...(github
      ? githubWriteTools({
          client: createGithubClient({ repo: github.repo, token: github.token, fetch }),
          repo: `${github.repo.owner}/${github.repo.name}`,
          workflowFiles: github.workflowFiles,
          ...(github.workflowRefs ? { workflowRefs: github.workflowRefs } : {}),
        })
      : []),
    ...(linear ? linearWriteTools({ client: createLinearClient({ apiKey: linear.apiKey, fetch }), triggerLabel: linear.triggerLabel }) : []),
  ];
}

import { createGithubClient } from "../../github";
import { createLinearClient } from "../../linear";
import type { PosthogReportConfig } from "../../posthogWeeklyReport/job";
import { githubTools } from "./github";
import { linearTools } from "./linear";
import { posthogTools } from "./posthog";
import { sentryTools } from "./sentry";
import type { AnyTool } from "./types";

export * from "./registry";
export * from "./types";

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

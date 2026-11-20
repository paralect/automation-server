import { createGithubClient } from "../../github";
import { createLinearClient } from "../../linear";
import { githubTools, githubWriteTools } from "./github";
import { linearTools, linearWriteTools } from "./linear";
import { posthogTools } from "./posthog";
import { sentryTools } from "./sentry";
export * from "./registry";
export { defineTool } from "./types";
export function buildReadTools({ github, sentry, posthog, linear, fetch }) {
    return [
        ...(github ? githubTools(createGithubClient({ repo: github.repo, token: github.token, fetch }), `${github.repo.owner}/${github.repo.name}`) : []),
        ...(sentry ? sentryTools({ ...sentry, fetch }) : []),
        ...(posthog ? posthogTools(posthog, { fetch }) : []),
        ...(linear ? linearTools(createLinearClient({ apiKey: linear.apiKey, fetch })) : []),
    ];
}
export function buildWriteTools({ github, linear, fetch }) {
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

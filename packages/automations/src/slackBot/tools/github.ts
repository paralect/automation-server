import { z } from "zod";

import type { GithubClient } from "../../github";
import { defineTool, failed, ok, type AnyTool } from "./types";

const MAX_BODY_CHARS = 2000;
const MAX_INPUTS = 10;
const MAX_INPUT_VALUE_CHARS = 1000;
const WORKFLOW_FILE = /^[A-Za-z0-9._-]+\.ya?ml$/;

export function githubTools(client: Pick<GithubClient, "searchIssues" | "getIssue">, repo: string): AnyTool[] {
  return [
    defineTool({
      name: "github.searchIssues",
      kind: "read",
      description: `Search issues in the ${repo} repository by keywords. Returns number, title, state, labels and url.`,
      argsSchema: z.object({
        query: z.string().min(1).max(200).describe("Keywords to search for"),
        limit: z.number().int().min(1).max(10).default(5),
      }),
      async run({ query, limit }) {
        return ok(await client.searchIssues(query, limit));
      },
    }),
    defineTool({
      name: "github.getIssue",
      kind: "read",
      description: `Read one issue of ${repo} by number, with its body and comment count.`,
      argsSchema: z.object({ number: z.number().int().min(1) }),
      async run({ number }) {
        const issue = await client.getIssue(number);
        if (!issue) return failed(`Issue #${number} was not found in ${repo}`);
        return ok({ ...issue, body: issue.body.slice(0, MAX_BODY_CHARS) });
      },
    }),
  ];
}

export type GithubWriteConfig = {
  readonly client: Pick<GithubClient, "createIssue" | "dispatchWorkflow" | "defaultBranch">;
  readonly repo: string;
  // Only workflows the project configured for its own automations may be started from Slack.
  readonly workflowFiles: readonly string[];
  // The ref the project configured for a workflow file. A file without one runs on the repository default branch. The model never picks a ref.
  readonly workflowRefs?: Readonly<Record<string, string>>;
};

export function githubWriteTools({ client, repo, workflowFiles, workflowRefs = {} }: GithubWriteConfig): AnyTool[] {
  const allowed = new Set(workflowFiles);
  const createIssue = defineTool({
    name: "github.createIssue",
    kind: "write",
    description: `Create an issue in the ${repo} repository. Labels that do not exist yet are created by GitHub.`,
    argsSchema: z.object({
      title: z.string().trim().min(1).max(200),
      body: z.string().max(4000),
      labels: z.array(z.string().trim().min(1).max(50)).max(5).optional(),
    }),
    async run({ title, body, labels }) {
      const issue = await client.createIssue({ title, body, labels: labels ?? [] });
      return ok(`Created GitHub issue #${issue.number} "${title}": ${issue.html_url}`);
    },
  });
  if (allowed.size === 0) return [createIssue];

  const dispatchWorkflow = defineTool({
    name: "github.dispatchWorkflow",
    kind: "write",
    description: `Start a GitHub Actions workflow in ${repo}. workflowFile must be one of: ${[...allowed].join(", ")}. It always runs on the configured ref or the repository default branch. inputs are string values the workflow declares.`,
    argsSchema: z.object({
      workflowFile: z.string().regex(WORKFLOW_FILE),
      inputs: z
        .record(z.string().min(1).max(100), z.string().max(MAX_INPUT_VALUE_CHARS))
        .refine((v) => Object.keys(v).length <= MAX_INPUTS, `at most ${MAX_INPUTS} inputs`)
        .optional(),
    }),
    async run({ workflowFile, inputs }) {
      if (!allowed.has(workflowFile)) return failed(`${workflowFile} is not an allowed workflow. Allowed: ${[...allowed].join(", ")}`);
      const target = workflowRefs[workflowFile] || (await client.defaultBranch());
      await client.dispatchWorkflow(workflowFile, target, inputs ?? {});
      return ok(`Started workflow ${workflowFile} in ${repo} on ${target}`);
    },
  });
  return [createIssue, dispatchWorkflow];
}

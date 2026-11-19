import { z } from "zod";

import type { GithubClient } from "../../github";
import { defineTool, failed, ok, type AnyTool } from "./types";

const MAX_BODY_CHARS = 2000;

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

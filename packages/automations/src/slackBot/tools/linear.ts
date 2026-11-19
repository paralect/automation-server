import { z } from "zod";

import type { LinearClient } from "../../linear";
import { defineTool, failed, ok, type AnyTool } from "./types";

const MAX_DESCRIPTION_CHARS = 2000;
const MAX_COMMENT_CHARS = 500;

export function linearTools(client: Pick<LinearClient, "searchIssues" | "getIssue">): AnyTool[] {
  return [
    defineTool({
      name: "linear.searchIssues",
      kind: "read",
      description: "Search Linear issues by keywords. Returns identifier, title, state, assignee and url.",
      argsSchema: z.object({
        query: z.string().min(1).max(200).describe("Keywords to search for"),
        limit: z.number().int().min(1).max(10).default(5),
      }),
      async run({ query, limit }) {
        return ok(await client.searchIssues(query, limit));
      },
    }),
    defineTool({
      name: "linear.getIssue",
      kind: "read",
      description: "Read one Linear issue by identifier such as ENG-123, with its description, labels and latest comments.",
      argsSchema: z.object({ identifier: z.string().regex(/^[A-Za-z][A-Za-z0-9]*-\d+$/, "expected an identifier like ENG-123") }),
      async run({ identifier }) {
        const issue = await client.getIssue(identifier.toUpperCase());
        if (!issue) return failed(`Linear issue ${identifier} was not found`);
        return ok({
          ...issue,
          description: issue.description.slice(0, MAX_DESCRIPTION_CHARS),
          comments: issue.comments.map((c) => ({ ...c, body: c.body.slice(0, MAX_COMMENT_CHARS) })),
        });
      },
    }),
  ];
}

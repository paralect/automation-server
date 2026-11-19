import { z } from "zod";

import type { LinearClient } from "../../linear";
import { defineTool, failed, ok, type AnyTool } from "./types";

const MAX_DESCRIPTION_CHARS = 2000;
const MAX_COMMENT_CHARS = 500;

const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9]*-\d+$/, "expected an identifier like ENG-123");
const labelName = z.string().trim().min(1).max(50);

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
      argsSchema: z.object({ identifier }),
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

export type LinearWriteConfig = {
  readonly client: Pick<LinearClient, "createIssue" | "addLabel">;
  // The label that starts the linear-label-to-pr automation, so the model and the approver both know what adding it does.
  readonly triggerLabel?: string;
};

const issueLine = (verb: string, issue: { identifier: string; title: string; url: string }) => `${verb} ${issue.identifier} "${issue.title}": ${issue.url}`;

export function linearWriteTools({ client, triggerLabel }: LinearWriteConfig): AnyTool[] {
  const trigger = triggerLabel
    ? ` Adding the label "${triggerLabel}" starts the automation that implements the issue and opens a pull request, so only add it when the user asked to run or implement the ticket.`
    : "";
  return [
    defineTool({
      name: "linear.createIssue",
      kind: "write",
      description: "Create a Linear issue. teamKey is the team key such as ENG and may be left out when the workspace has one team. Labels must already exist, they are never created.",
      argsSchema: z.object({
        title: z.string().trim().min(1).max(200),
        description: z.string().max(4000).optional(),
        teamKey: z.string().regex(/^[A-Za-z0-9]{1,10}$/).optional(),
        labels: z.array(labelName).max(5).optional(),
      }),
      async run(args) {
        return ok(issueLine("Created Linear issue", await client.createIssue(args)));
      },
    }),
    defineTool({
      name: "linear.addLabel",
      kind: "write",
      description: `Add an existing label to a Linear issue by identifier such as ENG-123. The label is looked up by name and must exist, it is never created.${trigger}`,
      argsSchema: z.object({ issue: identifier, label: labelName }),
      async run({ issue, label }) {
        const updated = await client.addLabel(issue.toUpperCase(), label);
        const started = triggerLabel && label.toLowerCase() === triggerLabel.trim().toLowerCase() ? " This label starts the implementation run." : "";
        return ok(`${issueLine(`Added label "${label}" to`, updated)}.${started}`);
      },
    }),
  ];
}

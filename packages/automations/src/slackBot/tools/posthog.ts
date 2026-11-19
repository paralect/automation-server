import { z } from "zod";

import { generateReport, type PosthogReportConfig, type ReportDeps } from "../../posthogWeeklyReport/job";
import { defineTool, ok, type AnyTool } from "./types";

export function posthogTools(config: PosthogReportConfig, deps: ReportDeps, now: () => Date = () => new Date()): AnyTool[] {
  return [
    defineTool({
      name: "posthog.weeklyReport",
      kind: "read",
      description: "The PostHog report for the last 7 days compared with the 7 before: unique users, pageviews, sessions, top pages and top events.",
      argsSchema: z.object({}),
      async run() {
        return ok((await generateReport(config, now(), deps)).text);
      },
    }),
  ];
}

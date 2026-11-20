import { z } from "zod";

import { fetchReport, type PosthogReportConfig, type ReportDeps } from "../../posthogWeeklyReport/job";
import { formatDelta, type Pair, type Ranked, type ReportData } from "../../posthogWeeklyReport/report";
import { defineTool, ok, type AnyTool } from "./types";

const DAY = 86_400_000;
const day = (d: Date) => d.toISOString().slice(0, 10);

const total = (metric: string, pair: Pair) => ({ metric, thisWeek: pair.current, previousWeek: pair.previous, change: formatDelta(pair) });
const top = (rows: readonly Ranked[]) => rows.map((r) => ({ name: r.name, thisWeek: r.current, previousWeek: r.previous, change: formatDelta(r) }));

// Raw numbers with dates and ready-made changes, so the model can lay out fields, a table and a daily chart without doing arithmetic.
// Metric names are values, not keys: redactUntrusted hides the value after any key like "sessions:", which once blanked the session count.
export function reportForModel(data: ReportData, now: Date, title: string) {
  const ago = [6, 5, 4, 3, 2, 1, 0];
  return {
    title,
    period: { from: day(new Date(now.getTime() - 7 * DAY)), to: day(now), comparedWith: "the 7 days before", timezone: "UTC" },
    totals: [total("Unique users", data.users), total("Pageviews", data.pageviews), total("Sessions", data.sessions)],
    dailyUniqueUsers: ago.map((d) => ({ date: day(new Date(now.getTime() - d * DAY)), thisWeek: data.dailyUsers[d] ?? 0, sameDayPreviousWeek: data.dailyUsers[d + 7] ?? 0 })),
    topPages: top(data.pages),
    topEvents: top(data.events),
  };
}

export function posthogTools(config: PosthogReportConfig, deps: ReportDeps, now: () => Date = () => new Date()): AnyTool[] {
  return [
    defineTool({
      name: "posthog.weeklyReport",
      kind: "read",
      description:
        "PostHog numbers for the last 7 days compared with the 7 before, as JSON: unique users, pageviews and sessions, unique users per day for both weeks, top pages and top events.",
      argsSchema: z.object({}),
      async run() {
        return ok(reportForModel(await fetchReport(config, deps), now(), config.reportTitle));
      },
    }),
  ];
}

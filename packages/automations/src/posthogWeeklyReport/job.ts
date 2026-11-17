import type { Job } from "@automation-server/core";
import type { SlackBlock } from "@chat-adapter/slack/blocks";

import { buildReportSpec, reportBlocks } from "./card";
import { createHogqlClient } from "./client";
import { fetchReportData } from "./queries";
import { buildReport } from "./report";
import { isDue } from "./schedule";
import { postToSlack } from "./slack";

export const POSTHOG_JOB_NAME = "posthog-weekly-report";

export type PosthogReportConfig = {
  readonly host: string;
  readonly projectId: string;
  readonly personalApiKey: string;
  readonly slackWebhookUrl: string;
  readonly reportTitle: string;
  readonly dayOfWeek: number;
  readonly hourUtc: number;
};

export type ReportDeps = { fetch?: typeof fetch };

const clientFor = (config: PosthogReportConfig, fetch: typeof globalThis.fetch | undefined) =>
  createHogqlClient({ host: config.host, projectId: config.projectId, apiKey: config.personalApiKey, fetch });

export type GeneratedReport = { readonly text: string; readonly blocks: SlackBlock[] };

export async function generateReport(config: PosthogReportConfig, now: Date, { fetch }: ReportDeps = {}): Promise<GeneratedReport> {
  const data = await fetchReportData(clientFor(config, fetch));
  return {
    text: buildReport(data, now, config.reportTitle),
    blocks: reportBlocks(buildReportSpec(data, now, config.reportTitle)),
  };
}

export async function countRecentEvents(config: PosthogReportConfig, { fetch }: ReportDeps = {}): Promise<number> {
  const rows = await clientFor(config, fetch).query("SELECT count() FROM events WHERE timestamp >= now() - INTERVAL 1 DAY");
  return Number(rows[0]?.[0] ?? 0);
}

export function createPosthogWeeklyReportJob(config: PosthogReportConfig, deps: ReportDeps = {}): Job {
  return {
    name: POSTHOG_JOB_NAME,
    due: (now) => isDue(now, config.dayOfWeek, config.hourUtc),
    async run({ log, now, key }) {
      log.info("building posthog report", { key });
      const { text, blocks } = await generateReport(config, now, deps);
      await postToSlack(config.slackWebhookUrl, text, { ...deps, blocks });
      log.info("posthog report sent", { key, characters: text.length, blocks: blocks.length });
    },
  };
}

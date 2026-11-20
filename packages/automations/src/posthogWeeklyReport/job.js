import { buildReportSpec, reportBlocks } from "./card";
import { createHogqlClient } from "./client";
import { fetchReportData } from "./queries";
import { buildReport } from "./report";
import { isDue } from "./schedule";
import { postToSlack } from "./slack";
export const POSTHOG_JOB_NAME = "posthog-weekly-report";
const clientFor = (config, fetch) => createHogqlClient({ host: config.host, projectId: config.projectId, apiKey: config.personalApiKey, fetch });
export async function generateReport(config, now, { fetch } = {}) {
    const data = await fetchReportData(clientFor(config, fetch));
    return {
        text: buildReport(data, now, config.reportTitle),
        blocks: reportBlocks(buildReportSpec(data, now, config.reportTitle)),
    };
}
export async function countRecentEvents(config, { fetch } = {}) {
    const rows = await clientFor(config, fetch).query("SELECT count() FROM events WHERE timestamp >= now() - INTERVAL 1 DAY");
    return Number(rows[0]?.[0] ?? 0);
}
export function createPosthogWeeklyReportJob(config, deps = {}) {
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

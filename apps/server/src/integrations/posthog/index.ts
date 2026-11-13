import type { PosthogAdmin } from "@automation-server/api/context";
import {
  countRecentEvents,
  createPosthogWeeklyReportJob,
  generateReport,
  POSTHOG_JOB_NAME,
} from "@automation-server/automations";
import type { Scheduler } from "@automation-server/core";
import type { ResolvedConfig } from "@automation-server/settings";

import { defineModule } from "../module";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const posthog = defineModule({
  id: "posthog",
  build({ posthog }, { log, fetch }) {
    if (!posthog.configured) return {};
    if (!posthog.values.enabled) {
      log.info("posthog weekly report is configured but disabled");
      return {};
    }
    return { jobs: [createPosthogWeeklyReportJob(posthog.values, { fetch })] };
  },
  async test({ posthog }, { fetch }) {
    if (!posthog.configured) return { ok: false, available: true, message: "PostHog is not configured" };
    const events = await countRecentEvents(posthog.values, { fetch });
    return {
      ok: true,
      available: true,
      message: `Connected to project ${posthog.values.projectId}. ${events} events in the last 24 hours.`,
      details: { projectId: posthog.values.projectId, eventsLastDay: String(events) },
    };
  },
});

export type PosthogAdminDeps = {
  resolve: (project: string) => ResolvedConfig;
  scheduler: Pick<Scheduler, "runNow">;
  fetch?: typeof fetch;
  now?: () => Date;
};

/** Backs `posthog.preview` and `posthog.runNow`. Both work while the schedule is disabled, so the report can be tried first. */
export function createPosthogAdmin({ resolve, scheduler, fetch, now = () => new Date() }: PosthogAdminDeps): PosthogAdmin {
  const notConfigured = (missing: readonly string[]) => `PostHog is not configured. Missing: ${missing.join(", ")}`;

  return {
    async preview(project) {
      const { posthog: config } = resolve(project);
      if (!config.configured) return { ok: false, message: notConfigured(config.missing) };
      const at = now();
      try {
        return { ok: true, text: (await generateReport(config.values, at, { fetch })).text, generatedAt: at.toISOString() };
      } catch (err) {
        return { ok: false, message: message(err) };
      }
    },
    async runNow(project) {
      const { posthog: config } = resolve(project);
      if (!config.configured) return { status: "not-configured", message: notConfigured(config.missing) };
      const key = `manual:${now().toISOString()}`;
      const result = await scheduler.runNow({ ...createPosthogWeeklyReportJob(config.values, { fetch }), project }, key);
      switch (result.status) {
        case "succeeded":
          return { status: "succeeded", runId: result.runId, key, message: "Report sent to Slack" };
        case "failed":
          return { status: "failed", runId: result.runId, key, message: result.error };
        default:
          return { status: "busy", message: `A ${POSTHOG_JOB_NAME} run is already in progress` };
      }
    },
  };
}

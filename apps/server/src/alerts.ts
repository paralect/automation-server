import { errorMessage } from "@automation-server/api/errors";
import { postToSlack, redactText, singleLine, truncate } from "@automation-server/automations";
import type { ActivityStore, Logger, RunRecord } from "@automation-server/core";
import { DEFAULT_PROJECT_ID, type ResolvedConfig } from "@automation-server/settings";

export type AlertNotifierDeps = {
  resolve: (project: string) => ResolvedConfig;
  activity: Pick<ActivityStore, "consecutiveFailures">;
  log: Logger;
  fetch?: typeof fetch;
  adminUrl?: string;
};

const MAX_ERROR_CHARS = 300;
const MAX_TRACKED_STREAKS = 1000;

const slackEscape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function createAlertNotifier({ resolve, activity, log, fetch, adminUrl }: AlertNotifierDeps) {
  // Two failures finishing together both read the same streak count, so the key is held in flight while the post runs. It becomes alerted only after the post succeeded, so a failed post can be retried. A success clears both.
  const alerted = new Set<string>();
  const posting = new Set<string>();

  const message = (run: RunRecord, project: string, streak: number, channelLabel: string | undefined) => {
    const error = truncate(singleLine(redactText(run.error ?? "unknown error")), MAX_ERROR_CHARS);
    const lines = [
      `:rotating_light: *${slackEscape(run.automation)}* has failed ${streak} times in a row${channelLabel ? ` (${slackEscape(channelLabel)})` : ""}`,
      `Project: \`${slackEscape(project)}\``,
      `Latest error: ${slackEscape(error)}`,
    ];
    if (adminUrl) lines.push(`Run: ${adminUrl}/runs/${encodeURIComponent(run.id)}`);
    return lines.join("\n");
  };

  return async (run: RunRecord): Promise<void> => {
    const project = run.project ?? DEFAULT_PROJECT_ID;
    const streakKey = `${project}/${run.automation}`;
    if (run.status === "succeeded") {
      alerted.delete(streakKey);
      posting.delete(streakKey);
      return;
    }
    if (run.status !== "failed") return;
    try {
      const { slack } = resolve(project);
      if (!slack.configured) return;
      const { failureThreshold, channelLabel } = slack.values;
      const streak = activity.consecutiveFailures(run.project ?? undefined, run.automation, failureThreshold);
      if (streak !== failureThreshold || alerted.has(streakKey) || posting.has(streakKey)) return;
      posting.add(streakKey);
      try {
        await postToSlack(slack.values.webhookUrl, message(run, project, streak, channelLabel), { fetch });
        // A success that finished during the post already cleared the streak, so the alert must not be remembered.
        if (posting.has(streakKey)) {
          if (alerted.size >= MAX_TRACKED_STREAKS) alerted.delete(alerted.values().next().value as string);
          alerted.add(streakKey);
        }
      } finally {
        posting.delete(streakKey);
      }
      log.info("failure alert sent", { project, automation: run.automation, streak });
    } catch (err) {
      log.warn("failure alert failed", { project, automation: run.automation, runId: run.id, error: errorMessage(err) });
    }
  };
}

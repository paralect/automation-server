import { errorMessage } from "@automation-server/api/errors";
import { postToSlack, redactText, singleLine, truncate } from "@automation-server/automations";
import type { ActivityStore, Logger, RunRecord } from "@automation-server/core";
import { DEFAULT_PROJECT_ID, INTEGRATIONS, type HealthStore, type IntegrationId, type ResolvedConfig, type StoredHealth } from "@automation-server/settings";

export type AlertNotifierDeps = {
  resolve: (project: string) => ResolvedConfig;
  activity: Pick<ActivityStore, "consecutiveFailures">;
  log: Logger;
  fetch?: typeof fetch;
  adminUrl?: string;
  health?: Pick<HealthStore, "markExpiryAlerted">;
};

const DAY_MS = 86_400_000;
export const EXPIRY_WARNING_DAYS = 14;
const EXPIRED_SUFFIX = ":expired";

export type HealthAlertKind = "failing" | "expiring" | "expired";

// The marker holds the expiry date already warned about, plus ":expired" once the expired alert went out, so each stage fires once per expiry date.
export function healthAlerts(previous: StoredHealth | undefined, current: StoredHealth, now: Date): HealthAlertKind[] {
  const kinds: HealthAlertKind[] = [];
  if (!current.ok && previous?.ok !== false) kinds.push("failing");
  const { expiresAt, alertedExpiry } = current;
  if (expiresAt) {
    const left = Date.parse(expiresAt) - now.getTime();
    if (left <= 0) {
      if (alertedExpiry !== `${expiresAt}${EXPIRED_SUFFIX}`) kinds.push("expired");
    } else if (left <= EXPIRY_WARNING_DAYS * DAY_MS && alertedExpiry !== expiresAt && alertedExpiry !== `${expiresAt}${EXPIRED_SUFFIX}`) {
      kinds.push("expiring");
    }
  }
  return kinds;
}

const MAX_ERROR_CHARS = 300;
const MAX_TRACKED_STREAKS = 1000;

const slackEscape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function createAlertNotifier({ resolve, activity, log, fetch, adminUrl, health }: AlertNotifierDeps) {
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

  const healthMessage = (project: string, integration: IntegrationId, current: StoredHealth, kinds: readonly HealthAlertKind[], now: Date, channelLabel: string | undefined) => {
    const title = INTEGRATIONS[integration].title;
    const label = channelLabel ? ` (${slackEscape(channelLabel)})` : "";
    const headline = kinds.includes("failing")
      ? `:warning: *${slackEscape(title)}* connection is failing${label}`
      : kinds.includes("expired")
        ? `:warning: *${slackEscape(title)}* token has expired${label}`
        : `:hourglass_flowing_sand: *${slackEscape(title)}* token expires soon${label}`;
    const lines = [headline, `Project: \`${slackEscape(project)}\``];
    if (!current.ok) lines.push(`Check result: ${slackEscape(truncate(singleLine(redactText(current.message)), MAX_ERROR_CHARS))}`);
    if (current.expiresAt) {
      const days = Math.ceil((Date.parse(current.expiresAt) - now.getTime()) / DAY_MS);
      lines.push(days > 0 ? `Expires: ${current.expiresAt.slice(0, 10)} (in ${days} day${days === 1 ? "" : "s"})` : `Expired: ${current.expiresAt.slice(0, 10)}`);
    }
    if (adminUrl) lines.push(`Integrations: ${adminUrl}/integrations/${encodeURIComponent(integration)}`);
    return lines.join("\n");
  };

  const notifyHealth = async (project: string, integration: IntegrationId, previous: StoredHealth | undefined, current: StoredHealth, now: Date): Promise<void> => {
    try {
      const { slack } = resolve(project);
      const { webhookUrl } = slack.values;
      if (!webhookUrl || !slack.values.alertOnTokenHealth) return;
      const kinds = healthAlerts(previous, current, now);
      if (kinds.length === 0) return;
      await postToSlack(webhookUrl, healthMessage(project, integration, current, kinds, now, slack.values.channelLabel), { fetch });
      if (current.expiresAt && (kinds.includes("expiring") || kinds.includes("expired"))) {
        health?.markExpiryAlerted(project, integration, kinds.includes("expired") ? `${current.expiresAt}${EXPIRED_SUFFIX}` : current.expiresAt);
      }
      log.info("token health alert sent", { project, integration, kinds });
    } catch (err) {
      log.warn("token health alert failed", { project, integration, error: errorMessage(err) });
    }
  };

  const onRunFinished = async (run: RunRecord): Promise<void> => {
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
      const { webhookUrl, failureThreshold, channelLabel } = slack.values;
      if (!webhookUrl) return;
      const streak = activity.consecutiveFailures(run.project ?? undefined, run.automation, failureThreshold);
      if (streak !== failureThreshold || alerted.has(streakKey) || posting.has(streakKey)) return;
      posting.add(streakKey);
      try {
        await postToSlack(webhookUrl, message(run, project, streak, channelLabel), { fetch });
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

  return { onRunFinished, notifyHealth };
}

import type { Event } from "@automation-server/core/event";

import type { SentryIssueAlert } from "./types";

export const SENTRY_SOURCE = "sentry";
export const SENTRY_ISSUE_ALERT = "issue_alert";

export type SentryIssueAlertEvent = Event<SentryIssueAlert, typeof SENTRY_ISSUE_ALERT>;

export function isSentryIssueAlert(event: Event): event is SentryIssueAlertEvent {
  return event.source === SENTRY_SOURCE && event.kind === SENTRY_ISSUE_ALERT;
}

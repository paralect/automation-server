export const SENTRY_SOURCE = "sentry";
export const SENTRY_ISSUE_ALERT = "issue_alert";
export function isSentryIssueAlert(event) {
    return event.source === SENTRY_SOURCE && event.kind === SENTRY_ISSUE_ALERT;
}

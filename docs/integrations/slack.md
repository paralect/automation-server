# Slack alerts

Posts to a Slack channel when an automation fails several times in a row.

- Settings spec: `slack` in `packages/settings/src/spec.ts`.
- Server module: `apps/server/src/integrations/slack`, which only provides the connection test.
- Notifier: `apps/server/src/alerts.ts`. The dispatcher and the scheduler call it through `onRunFinished` once a run has succeeded or failed.
- Admin API: `settings.testConnection` with `integrationId: "slack"`.

## Settings

| Field | Env | Default | Meaning |
| --- | --- | --- | --- |
| `webhookUrl` | `SLACK_ALERTS_WEBHOOK_URL` | | Required. Incoming webhook of the alerts channel. Must start with `https://`. Stored encrypted. |
| `failureThreshold` | | `3` | Failures in a row that trigger an alert. 1 to 50. |
| `alertOnTokenHealth` | | `true` | Reserved for token health alerts. |
| `channelLabel` | | | Optional text shown in the alert, for example `#alerts`. |

The server variable `ADMIN_PUBLIC_URL` is optional. When it is set, the alert links to `<ADMIN_PUBLIC_URL>/runs/<run id>`.

## The rule

The rule has no state of its own. After a run fails, the server counts the automation's failed runs in a row, newest first, in that project. It posts when the count equals the threshold exactly.

- Counting stops at the first `succeeded` run. Only `succeeded` and `failed` runs are looked at.
- `duplicate` runs, dry runs and runs that ended with `interrupted by server restart` are skipped. A skipped run neither counts nor breaks the streak.
- Replays count like any real run. Dry-run replays do not.
- A failure beyond the threshold does not alert again. After a success, the next streak that reaches the threshold alerts again.
- The streak is read from the stored runs, so it survives restarts. A small in-process guard stops two failures that finish at the same moment from posting twice. It remembers an alert only after Slack accepted the post, so a failed post is not lost: the next run that finishes at the same streak length, for example a replay, tries again.

Settings are read when the alert is sent, so a saved change applies at once. A project without a configured webhook sends nothing.

## The message

The text names the automation, the project and the streak length. It quotes the error of the run that triggered the alert, passed through the same redaction the stored runs use and cut to 300 characters. It adds the channel label when one is set and the run link when `ADMIN_PUBLIC_URL` is set.

A failed post is logged at `warn` and never fails the run. The error carries the HTTP status only, never the response body, and the webhook URL is removed from every error before it is logged.

## Connection test

**Test connection** posts `Automation server alerts are connected` to the webhook and reports success or the error Slack returned.

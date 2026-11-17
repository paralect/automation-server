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
| `alertOnTokenHealth` | | `true` | Also alert when a connected token stops working or is about to expire. See [Token health](#token-health). |
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

## Token health

The runtime registers a scheduled job `token-health` for every project. It is due once a day, at or after 06:00 UTC, under the key of the UTC date, so a restart does not repeat it. Its runs appear on the Runs page like any other job.

The job calls the connection test of every configured integration that has one, one after another, and stores the result in `integration_health` (project, integration, checked_at, ok, message, expires_at, alerted_expiry). The admin **Test** button goes through the same path, so a manual test is recorded and can alert too. Each test has an 8 second limit and reports `timed out` when it is hit.

| Integration | What is probed | Expiry |
| --- | --- | --- |
| GitHub | `GET /user`, then the issues repository | `github-authentication-token-expiration` response header |
| Sentry | `GET <apiBaseUrl>/api/0/` with the auth token. 401 and 403 are rejections. Without an auth token it passes and says enrichment is off. | None |
| OpenRouter | `GET /key` | `expires_at` when OpenRouter returns it |
| Linear | The GitHub token and the installed workflow file | None |
| Crisp | The website read with the plugin token | None |
| PostHog | A count query over the last day | None |
| Slack alerts | Not part of the daily check, because its test posts a message. The Test button still runs it. | None |

Expiry is a limitation of the services. Only GitHub fine-grained tokens expose it, and classic tokens never expire. Sentry, Linear, Crisp and PostHog keys carry no expiry, so for them the check can only tell you the key is already broken.

With `alertOnTokenHealth` on and a webhook set, `notifyHealth` posts when:

1. A check that was ok, or never ran, now fails. A first check that already fails alerts once.
2. The expiry is within 14 days and differs from `alerted_expiry`. The expiry date is then stored in `alerted_expiry`.
3. The token has already expired. `alerted_expiry` becomes `<expiry>:expired`.

If Slack is unreachable when a token first fails, that transition is not re-sent. The next alert comes from a later change of state. Nothing is posted while the state stays bad. A check that fails on an expired token is one message. The text carries the integration, the project, the scrubbed check result, the expiry and, when `ADMIN_PUBLIC_URL` is set, a link to `<ADMIN_PUBLIC_URL>/integrations/<id>`.

## Connection test

**Test connection** posts `Automation server alerts are connected` to the webhook and reports success or the error Slack returned.

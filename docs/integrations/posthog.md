# PostHog integration

Sends a short week-over-week PostHog report to a Slack channel once a week.

- Job: `packages/automations/src/posthogWeeklyReport`, named `posthog-weekly-report`.
- Server module: `apps/server/src/integrations/posthog`.
- Admin API: `posthog.preview`, `posthog.runNow` and `settings.testConnection` with `integrationId: "posthog"`.

PostHog has no webhook here. The report is a scheduled job, so there is no URL to paste anywhere.

## The report

The job runs three HogQL queries through `POST {host}/api/projects/{projectId}/query/` and compares the last 7 days with the 7 days before them:

- unique users, pageviews (`$pageview`) and sessions (`$session_id`),
- the top 10 pages by pageviews (`$pathname`),
- the top 10 events.

The windows are relative to PostHog's clock when the job runs, so a report sent on Monday at 09:00 UTC covers Monday 09:00 to Monday 09:00. Each line shows this week's count, the change in percent and last week's count. A row that had no count last week shows `new`. The text uses Slack mrkdwn and is posted to an incoming webhook as `{ "text": ... }`.

## Schedule and deduplication

The server ticks every 60 seconds. The job is due once the configured weekday (`dayOfWeek`, 0 is Sunday) and hour (`hourUtc`) have passed in the current ISO week, which runs Monday to Sunday. The claim key is `posthog-weekly-report:<ISO week>`, for example `posthog-weekly-report:2026-W08`, so each week is sent at most once, also across restarts.

Consequences worth knowing:

- If the server is down at the scheduled time, the report goes out on the first tick after it comes back, as long as it is still the same ISO week.
- Enabling the job, or moving the schedule earlier, after this week's time has passed sends this week's report on the next tick.
- A failed run keeps its claim and is not retried automatically, so a broken key or webhook does not fail once a minute. Use Send now (`posthog.runNow`) to retry.

Every run, scheduled or manual, is recorded in the activity store as a run with automation `posthog-weekly-report` and source `schedule`. It shows on the Runs and Logs pages of the admin.

## Admin API

All three need the admin token. None of the responses contain the API key or the Slack webhook URL.

| Route | Input | Output |
| --- | --- | --- |
| `posthog.preview` | none | `{ ok: true, text, generatedAt }` or `{ ok: false, message }`. Queries PostHog and returns the text. Nothing is sent and no run is recorded. |
| `posthog.runNow` | none | `{ status: "succeeded" \| "failed", runId, key, message }` or `{ status: "busy" \| "not-configured", message }`. Sends now under the key `manual:<ISO timestamp>`, also while the schedule is disabled. `runId` points at the recorded run. |
| `settings.testConnection` | `{ integrationId: "posthog" }` | Runs `SELECT count() FROM events` over the last day and reports the count. |

A manual run uses its own key, so it does not use up the weekly send.

## Setup

### PostHog

1. In PostHog, open your project settings and copy the Project ID.
2. Open account settings, Personal API keys, and create a key. Limit it to the project and give it the Query: Read scope.
3. Note your host. US Cloud is `https://us.posthog.com`, EU Cloud is `https://eu.posthog.com`, a self-hosted instance uses its own URL.

### Slack

Create a Slack app with Incoming Webhooks enabled, add a webhook to the channel that should receive the report, and copy its URL. Treat the URL as a secret: anyone with it can post to the channel.

## Configuration

PostHog is configured only from the admin (Integrations page, or `settings.update` with `integrationId: "posthog"`). There are no environment variables. Secrets need `SETTINGS_ENCRYPTION_KEY` on the server. A change takes effect without a restart.

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `host` | yes | `https://us.posthog.com` | PostHog host. |
| `projectId` | yes | | Project ID. |
| `personalApiKey` | yes, secret | | Personal API key with Query: Read. |
| `slackWebhookUrl` | yes, secret | | Slack incoming webhook URL. |
| `enabled` | no | `false` | Puts the weekly job on the schedule. Preview and Send now work without it. |
| `dayOfWeek` | no | `1` | Weekday to send on, 0 (Sunday) to 6 (Saturday). |
| `hourUtc` | no | `9` | Hour to send at, 0 to 23, in UTC. |
| `reportTitle` | no | `Weekly PostHog report` | First line of the report. |

The integration counts as configured once the four required fields are set. The job is scheduled only when it is configured and `enabled` is true.

## Privacy

Errors from PostHog and Slack are scrubbed of the API key and the webhook URL before they are logged, stored on the run or returned by the API. The report itself contains page paths and event names from your project, so pick the Slack channel accordingly.

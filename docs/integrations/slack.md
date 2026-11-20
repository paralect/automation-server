# Slack

One integration for Slack. It posts failure alerts and token-health alerts to a channel through an incoming webhook, and runs the Slack bot that answers when a member tags it.

- Settings spec: `slack` in `packages/settings/src/spec.ts`.
- Server module: `apps/server/src/integrations/slack`. It builds the bot and provides the connection test.
- Notifier: `apps/server/src/alerts.ts`. The dispatcher and the scheduler call it through `onRunFinished` once a run has succeeded or failed.
- Admin API: `settings.testConnection` with `integrationId: "slack"`.

## Settings

| Field | Env | Default | Meaning |
| --- | --- | --- | --- |
The admin shows the fields in four sections, in this order. A field's section is its `group` in the spec.

| Section | Field | Env | Default | Meaning |
| --- | --- | --- | --- | --- |
| Connection | `botToken` | `SLACK_BOT_TOKEN` | | Bot User OAuth Token (`xoxb-`). Stored encrypted. |
| Connection | `signingSecret` | `SLACK_SIGNING_SECRET` | | Signing Secret of the Slack app. Stored encrypted. |
| Access | `botEnabled` | | `false` | Switches the bot and its webhook route on. |
| Access | `allowedUsers` | | empty | Member IDs allowed to use the bot. Empty means nobody. Kind `slackUsers`: a list of IDs, chosen in the admin from the Slack directory. |
| Access | `allowedChannels` | | empty | Channel IDs (`C...` or `G...`) where the bot answers. Empty means any channel it was invited to. Otherwise a mention elsewhere is ignored without a reply and recorded with the decision `channel-not-allowed`. Kind `slackChannels`. |
| Access | `requireApproval` | | `true` | A write the model proposes runs only after the requester approves it in the thread. Off runs it at once. See [Changes and approval](../setup/slack-bot.md#changes-and-approval). |
| Alerts | `webhookUrl` | `SLACK_ALERTS_WEBHOOK_URL` | | Optional. Incoming webhook of the alerts channel. Must start with `https://`. Stored encrypted. Without it no alert is sent. |
| Alerts | `failureThreshold` | | `3` | Failures in a row that trigger an alert. 1 to 50. |
| Alerts | `alertOnTokenHealth` | | `true` | Also alert when a connected token stops working or is about to expire. See [Token health](#token-health). |
| Alerts | `channelLabel` | | | Optional text shown in the alert, for example `#alerts`. |
| Advanced | `agentModel` | | | OpenRouter model that answers the bot. Empty uses the OpenRouter escalation model. |
| Advanced | `botName` | | | Optional name shown as `@name approve` in the approval message. |
| Advanced | `apiBaseUrl` | | `https://slack.com/api` | Slack Web API host. Must start with `https://`. Change only for a proxy or a test double. |

The integration counts as configured with `botToken` and `signingSecret`, or with the alert webhook. It declares this with `requiredOneOf` in the spec. While nothing is set the card says `Add the bot token and signing secret, or an alerts webhook URL.`, built from the field labels. Once one of the ways is half set, it names the fields still missing there.

`slackUsers` and `slackChannels` are list kinds: the stored value is a plain list of Slack IDs, so env values (comma separated) and existing installs keep working. Only the admin renders them as pickers.

## Directory API

The admin pickers read the workspace through `slack.directory({ project, kind: "users" | "channels", search?, refresh? })`. It returns `{ items: { id, label, detail?, member? }[], truncated }`.

- It runs on the server with the saved bot token. The token is never sent to the browser, and it is scrubbed from errors.
- `users`: `users.list` without deactivated accounts, bots, app users and Slackbot. The label is the display name or the real name, the detail is `@handle`. Needs `users:read`.
- `channels`: public and private channels, archived ones excluded. The bot's own channels come first from `users.conversations`, so a private channel the bot was added to shows even when the workspace is too big for `conversations.list` to read in full; the rest of the workspace follows from `conversations.list`. The label is `#name` and `member` says whether the bot was invited. Needs `channels:read` and `groups:read`.
- Slack is read with a page size of 200 and at most 5 pages. `truncated` is `true` when there was more. `search` filters on the server by label and handle, ignoring case, and at most 200 items come back.
- The server keeps each (project, kind) list for 60 seconds in a bounded in-memory map. A different bot token or API base URL never reuses it. `refresh: true` skips the cache.
- Errors: no saved bot token gives `PRECONDITION_FAILED` (`Save the bot token first.`). `missing_scope` gives `BAD_GATEWAY` naming the scope to add. `invalid_auth` and `token_revoked` give `BAD_GATEWAY` (`Slack rejected the bot token.`). A project the caller does not own is `NOT_FOUND`.

The server variable `ADMIN_PUBLIC_URL` is optional. When it is set, the alert links to `<ADMIN_PUBLIC_URL>/runs/<run id>`.

## Slack bot

The bot is the `slack-bot` automation over the `slack` source. See [docs/setup/slack-bot.md](../setup/slack-bot.md) for the Slack app.

- Source: `packages/sources/src/slack`. `POST /webhooks/:project/slack` verifies the Slack v0 signature (`HMAC-SHA256` of `v0:<timestamp>:<raw body>`, compared in constant time, timestamp within 5 minutes). `url_verification` is answered through the optional `Source.respond` hook before anything is parsed. Only `app_mention` becomes an event, and events with `bot_id`, a `bot_message` subtype or the bot's own user ID are ignored.
- Event: `{source: "slack", kind: "app_mention", externalId: <event_id>, payload: {team, channel, user, text, ts, threadTs}}`. The leading `<@BOT>` is stripped from `text`. Using `event_id` as the claim key makes Slack's retries `duplicate` runs.
- Client: `packages/automations/src/slackBot/client.ts`, `auth.test`, `chat.postMessage`, `conversations.replies` and the directory reads `users.list`, `users.conversations` and `conversations.list`, with injectable `fetch`, `redirect: "error"`, a 10 second timeout and the token scrubbed from every error.
- Limits: `packages/automations/src/slackBot/limiter.ts`, in memory per server process. Allowed members get 6 requests a minute each (a token bucket per project and member), one slow-down reply per member per minute and silence after that. A member outside `allowedUsers` gets the denial at most once per 10 minutes and silence otherwise. At most 4 runs are in flight per project, extra mentions get one `I am busy` reply per member per minute. Maps are bounded and old entries are evicted. A dry run spends no quota.
- Automation: `packages/automations/src/slackBot/automation.ts`. A mention from a channel outside a non-empty `allowedChannels` is ignored first: nothing is posted, the limiter, thread read and agent never run, and the run records the decision `channel-not-allowed`. This covers `approve` and `cancel` too. A user outside `allowedUsers` gets the denial reply (see Limits) and nothing else runs. A listed user's question goes to the agent and the answer is posted in the thread (`threadTs ?? ts`), escaped so it cannot ping. In a dry run it logs `dry-run: would reply`, reports the reply on the run and posts nothing.
- Agent: `packages/automations/src/slackBot/agent.ts`. At most 6 steps and 120 seconds per question. Each step is one structured model call that returns a tool call or the final answer. The handler (`handler.ts`) reads the thread with `conversations.replies` (the newest 20 messages, paged with the cursor up to 5 pages, redacted, kept within 6000 characters) only when the mention is inside a thread.
- Tools: `packages/automations/src/slackBot/tools`. A registry of `{name, description, kind, argsSchema, run}`. Arguments are validated with zod before `run`. Results are redacted and then cut to 4000 characters before they go back into the prompt. An integration that is not configured contributes no tools, so the model is never told about it. Tools are `kind: "read"` or `kind: "write"`. The agent loop never runs a write: it validates the arguments and returns a proposal. See [docs/setup/slack-bot.md](../setup/slack-bot.md#what-the-bot-can-do).
- Outcome: each step is logged on the run (`agent step`, with tool, redacted arguments and duration) and the run reports a compact outcome (`packages/sources/src/slack/outcome.ts`: status, step count, tools used).
- Connection test: `auth.test` when `botToken` is set (bot name and workspace, never the token), and the webhook test message when `webhookUrl` is set. The daily token-health check runs only the `auth.test` part, and only when `botToken` is set, so it never posts the test message.
- Stored events keep the message text. They are redacted by key name only.

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
| Linear | The GitHub token and the installed workflow file, and a `viewer` query when the API key is set | None |
| Crisp | The website read with the plugin token | None |
| PostHog | A count query over the last day | None |
| Slack | `auth.test` for the bot token, only when a bot token is set. The webhook test message is posted only by the Test button, never by the daily check. A webhook-only Slack is not part of the daily check. | None |

Expiry is a limitation of the services. Only GitHub fine-grained tokens expose it, and classic tokens never expire. Sentry, Linear, Crisp and PostHog keys carry no expiry, so for them the check can only tell you the key is already broken.

With `alertOnTokenHealth` on and a webhook set, `notifyHealth` posts when:

1. A check that was ok, or never ran, now fails. A first check that already fails alerts once.
2. The expiry is within 14 days and differs from `alerted_expiry`. The expiry date is then stored in `alerted_expiry`.
3. The token has already expired. `alerted_expiry` becomes `<expiry>:expired`.

If Slack is unreachable when a token first fails, that transition is not re-sent. The next alert comes from a later change of state. Nothing is posted while the state stays bad. A check that fails on an expired token is one message. The text carries the integration, the project, the scrubbed check result, the expiry and, when `ADMIN_PUBLIC_URL` is set, a link to `<ADMIN_PUBLIC_URL>/integrations/<id>`.

## Connection test

**Test connection** posts `Automation server alerts are connected` to the webhook and reports success or the error Slack returned.

# Set up the Slack bot

This guide creates a Slack app that your team tags in a channel. The bot reads the question (and the thread it was tagged in), asks an AI model, and lets the model look things up in the services you connected. It answers in the thread. It can only read. It cannot create, change or run anything yet.

The bot answers only members you list. Everything is configured on the admin Integrations page, in the **Slack** card, next to the alert settings. The alert webhook is optional. You can run the bot without it, or the alerts without the bot.

## What the bot can do

The bot is a language model with a short list of tools. A tool is offered to the model only when its service is set up. A service that is not set up has no tool, and the model is not told it exists.

| Tool | Needs | What it returns |
| --- | --- | --- |
| `github.searchIssues` | GitHub token and **Issues repository** | Issues of that repository matching keywords: number, title, state, labels, link. A `repo:` or `org:` word in the query is stripped, so the search stays inside the repository. |
| `github.getIssue` | The same | One issue with its body (first 2000 characters) and comment count. |
| `sentry.listIssues` | Sentry **Auth token** (and **API base URL**) | Issues of the token's organization, newest activity first, for a Sentry search query. |
| `posthog.weeklyReport` | PostHog fully configured | The same numbers as the weekly report: users, pageviews, sessions, top pages and events. It posts nothing to Slack. |
| `linear.searchIssues` | Linear **API key** | Issues matching keywords: identifier, title, state, assignee, link. |
| `linear.getIssue` | Linear **API key** | One issue with its description, labels and latest comments. |

Examples to ask: `@Automation Bot what Linear issues mention billing?`, `@Automation Bot is there a GitHub issue about the login timeout?`, `@Automation Bot what are the top Sentry errors this week?`, `@Automation Bot how did signups change in PostHog?`

Limits that keep a question bounded:

- At most 6 tool steps and 2 minutes per question. After that the bot says it ran out of steps.
- Each tool result is cut to 4000 characters before the model sees it.
- The thread context is the first 20 messages of the thread, newest kept within about 6000 characters.
- The model answers in your language, short, in Slack formatting.

If OpenRouter is not configured the bot replies `The AI model is not configured.` and does nothing else. If anything fails it replies `I could not do that: <reason>` with the reason scrubbed of secrets.

## Model choice and cost

The bot uses the **Agent model** field of the Slack card. If it is empty it uses the **Escalation model** of the OpenRouter integration (`anthropic/claude-sonnet-5.5` by default). The model must support structured outputs, like the Crisp triage models.

Each question costs one to seven model calls, and each call carries the thread, the question and the tool results so far, up to a few thousand tokens. A typical question with one tool is two calls. Set a credit limit on the OpenRouter key, and use a cheaper model in **Agent model** if cost matters. Only listed members can trigger calls, so the allowlist is also your cost control.

## Treat everything the bot reads as untrusted

Issue bodies, comments, Sentry titles and other people's Slack messages can contain text written to trick an AI model ("ignore your instructions and ..."). The bot is built for that:

- The model is told that thread text and tool results are data, never instructions, and they are fenced in the prompt so they cannot close the fence.
- The model can only call the tools in the table above. It has no shell, no arbitrary HTTP, and no write tool. A call to anything else is refused and counted as a step.
- Every tool result and every piece of thread text is redacted (tokens, emails, long secrets) before it goes into a prompt, and the same redaction is applied to what is logged.
- The answer is escaped before it is posted, so a hostile issue cannot make the bot ping `@channel` or a person. Links the model writes show as plain text and Slack still makes URLs clickable.

This lowers the risk. It does not remove it: a model can still repeat misleading text from an issue in its answer. Read answers as you would read the issue itself.

## 1. Create the Slack app

1. Open [api.slack.com/apps](https://api.slack.com/apps), click **Create New App** and choose **From a manifest**.
2. Pick your workspace and paste this manifest. Replace `<server>` with your public server URL and `<project>` with the project slug (`default` unless you changed it).

```yaml
display_information:
  name: Automation Bot
features:
  bot_user:
    display_name: Automation Bot
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - channels:history
      - groups:history
settings:
  event_subscriptions:
    request_url: https://<server>/webhooks/<project>/slack
    bot_events:
      - app_mention
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

Scopes:

- `app_mentions:read` lets Slack send the bot the messages that tag it.
- `chat:write` lets it answer.
- `channels:history` and `groups:history` let it read the thread it was tagged in (public and private channels). If you leave them out the bot still answers, but without the earlier messages of the thread. The run log then shows `could not read the thread, answering without it`. Reinstall the app after adding scopes.

3. Click **Create**. Slack checks the request URL right away. If the server is not reachable yet or the signing secret is not saved, the check fails. Save the secrets in step 2 first, then open **Event Subscriptions** and click **Retry**. The server answers the check on its own.

## 2. Copy the secrets into the admin

1. In the Slack app, open **Basic Information**, find **Signing Secret**, click **Show** and copy it.
2. Open **Install App**, click **Install to Workspace** and allow it. Copy the **Bot User OAuth Token**, which starts with `xoxb-`.
3. In the admin open **Integrations**, then the **Slack** card, and fill in:

| Field | Value |
| --- | --- |
| Bot token | The `xoxb-` token. Env: `SLACK_BOT_TOKEN`. |
| Signing secret | The signing secret. Env: `SLACK_SIGNING_SECRET`. |
| Bot enabled | On. The route `/webhooks/<project>/slack` only exists while this is on. |
| Allowed users | Member IDs, one per line. Empty means nobody can use the bot. |
| Agent model | Optional. An OpenRouter model id. Empty uses the OpenRouter escalation model. |
| Bot name | Optional. Used in help text. |

4. Set up OpenRouter (see [OpenRouter](openrouter.md)), and any service you want the bot to read: GitHub token and issues repository, Sentry auth token, PostHog, and the Linear **API key** ([Linear](linear.md)). Each one adds its tools.
5. Click **Save**, then **Test connection**. It calls `auth.test` and shows the bot name and the workspace. It never shows the token, and it posts no message unless you also set the alert webhook.

The card also shows the **Webhook URL** to use as the Slack request URL. It needs `PUBLIC_URL` on the server.

The daily token check also calls `auth.test` for the bot token, and alerts when it stops working. It never posts the alert webhook's test message.

## 3. Find member IDs for the allowlist

In Slack, open the person's profile, click the three dots (**More**) and choose **Copy member ID**. It looks like `U01ABCDEF23`. Paste one ID per line into **Allowed users**.

The allowlist is the only gate. Someone who is not listed gets `You are not allowed to use this bot. Ask an admin to add your member ID.` at most once every 10 minutes, and nothing at all in between. No model call, tool call or thread read happens for them.

## Rate limits

The server limits the bot in memory, per project, so a loop or a flood cannot run up model cost. The limits reset when the server restarts.

| Rule | Limit | What the sender sees |
| --- | --- | --- |
| Allowed member | 6 requests a minute each. The allowance refills one request every 10 seconds. | One `You are sending requests too fast, wait a minute.` per member per minute. Further requests are dropped without a reply. |
| Member who is not allowed | The denial is sent at most once per member per 10 minutes. | The denial once, then nothing. |
| Concurrent runs | 4 at a time per project. | One `I am busy, try again in a minute.` per member per minute, then nothing. |

Normal use never reaches these limits. A dry run does not use up any allowance. A dropped mention still shows as a run on the Runs page with the decision `rate-limited`, `busy` or `denied`.

## 4. Invite the bot and try it

Invite the bot to a channel (`/invite @Automation Bot`), then write `@Automation Bot what Linear issues mention billing?`. A listed member gets the answer in a thread under the message. To continue, reply in that thread and tag the bot again: it reads the earlier messages as context.

Each mention is a run of the `slack-bot` automation on the **Runs** page. Open one to see who asked, the channel and the reply. Every tool call is a log line `agent step` with the tool name, the redacted arguments and how long it took. The run's outcome lists the final status (`answered`, `exhausted`, `failed` or `not-configured`), the step count and the tools used. Slack retries an event it thinks was not delivered in time. The server uses the event ID as the claim, so a retry is shown as a `duplicate` run and does not reply twice.

## What is checked and stored

- Every request must carry a valid `X-Slack-Signature` for the signing secret and a timestamp within five minutes. Otherwise the server answers `401` and runs nothing.
- Messages written by a bot, including this one, are ignored, so the bot cannot trigger itself.
- The message text is stored with the event so a run can be replayed. Stored events are redacted by key name only (keys such as `token` or `secret`), not by content, so a secret pasted into a message is stored as written. Tell people not to paste secrets to the bot. The text is redacted by content before it goes to the model and before it is logged.
- To rehearse without posting, replay the run as a dry run from its page. The bot still reads (model and tools), logs what it would reply and posts nothing.
- A failed answer does not fail the run: the thread gets `I could not do that: ...` and the outcome status says `failed`. A failed Slack post does fail the run, and Slack's retry can reply again.

## Known limits

- **The bot reads with the shared token.** Every read uses the token or API key of the project, not the access of the person who asked. Anyone on the allowlist can learn what those tokens can see, so give them only access you are happy to share with that list.
- **One Slack workspace per project is assumed.** A pending request is found by project, channel and thread. The workspace ID is stored with it but not compared. Do not point one project at an app installed in several workspaces.
- **Sentry uses the first organization.** `sentry.listIssues` searches the first organization the auth token can see. A token that belongs to several organizations always reads from the same one.
- **Stored Slack events are redacted by key name and by secret shape only.** Keys such as `token`, `secret` or `key` are replaced, and values that look like a Slack, GitHub, OpenRouter, Linear or PostHog token, a bearer token, a JWT or a Slack webhook URL are replaced wherever they are. A secret in some other form, such as a password pasted in a sentence, is stored as written. Tell people not to paste secrets into Slack when they talk to the bot.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Slack says the request URL did not respond | The server is not public, `PUBLIC_URL` or the slug is wrong, **Bot enabled** is off, or the signing secret is missing. |
| `invalid_auth` in Test connection | The bot token is wrong or the app was reinstalled and the token rotated. |
| The bot never answers | It is not in the channel, or the member ID is not in **Allowed users** (you get the denial then). |
| `channel_not_found` in the run error | The bot is not a member of that channel. Invite it. |
| `The AI model is not configured.` | The OpenRouter API key is not set. |
| `I could not do that: ... does not match the schema` | The Agent model does not support structured outputs. Pick another model. |
| The bot says it has no way to look something up | The service for that question has no tool: its token is not set, or for GitHub the **Issues repository** is empty. |
| The run log says `could not read the thread` | The app lacks `channels:history` or `groups:history`, or the bot is not in the channel. |

# Set up the Slack bot

This guide creates a Slack app that your team tags in a channel. The bot reads the question (and the thread it was tagged in), asks an AI model, and lets the model look things up in the services you connected. It answers in the thread. It can also propose changes (create an issue, label a ticket, start a workflow), but it never makes one until the person who asked approves it in the thread. See [Changes and approval](#changes-and-approval).

The bot answers only the users you choose. Everything is configured on the admin Integrations page, in the **Slack** card. The setup order is: create the app, install it, paste the bot token and signing secret and save, then choose users and channels from your live Slack directory in the admin, then invite the bot and try it. The alert webhook is optional. You can run the bot without it, or the alerts without the bot.

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

The changes the bot can propose are listed under [Changes and approval](#changes-and-approval).

Examples to ask: `@Automation Bot what Linear issues mention billing?`, `@Automation Bot is there a GitHub issue about the login timeout?`, `@Automation Bot what are the top Sentry errors this week?`, `@Automation Bot how did signups change in PostHog?`

Limits that keep a question bounded:

- At most 6 tool steps and 2 minutes per question. After that the bot says it ran out of steps.
- Each tool result is cut to 4000 characters before the model sees it.
- The thread context is the newest 20 messages of the thread (the bot pages through up to 1000 messages), kept within about 6000 characters.
- The model answers in your language, short, in Slack formatting.

If OpenRouter is not configured the bot replies `The AI model is not configured.` and does nothing else. If anything fails it replies `I could not do that: <reason>` with the reason scrubbed of secrets.

## Changes and approval

Write tools exist only when their service is set up, like read tools. When the model picks one, the bot does not run it. The server checks the arguments, stores the request, and posts the exact tool and arguments in the thread. Nothing happens until the person who asked replies `approve`.

| Tool | Needs | What it does |
| --- | --- | --- |
| `linear.createIssue` | Linear **API key** | Creates an issue. Arguments: `title`, optional `description`, optional `teamKey` (needed only when the workspace has more than one team), optional `labels`. Labels must already exist in Linear. A missing label is an error, the bot never creates labels. |
| `linear.addLabel` | Linear **API key** | Adds an existing label to an issue, found by name (`issue` is an identifier like `ENG-123`, `label` is the name). A missing label or issue is an error. |
| `github.createIssue` | GitHub token and **Issues repository** | Creates an issue in that repository. Arguments: `title`, `body`, optional `labels`. GitHub itself creates a label that does not exist yet. |
| `github.dispatchWorkflow` | GitHub token and **Issues repository**, and at least one allowed workflow | Starts a GitHub Actions workflow in that repository. Arguments: `workflowFile`, optional `inputs`. There is no `ref`: it always runs on the ref configured for that workflow (the Linear **Ref** for the Linear workflow file) or on the repository default branch, never on one the model picks. |

**What "run a ticket" means.** There is no separate run tool. Adding the Linear **trigger label** to an issue is what starts the `linear-label-to-pr` automation, which dispatches the implementation workflow and opens a pull request. So "run ENG-123" becomes `linear.addLabel` with the trigger label, and the approval message shows exactly that. The tool description tells the model this, and also that it should only add that label when the person asked to run or implement the ticket.

**Allowed workflows.** `github.dispatchWorkflow` refuses any file that is not on a list built from the project's own settings: the Crisp **Workflow file**, and the Linear **Workflow file** when Linear's **Target repository** is the same repository as the GitHub **Issues repository**. A file such as `deploy-prod.yml` is refused even if the model, or text it read, asks for it. The list is checked again when the request is approved.

### The approval flow

1. A listed member asks for a change. The model picks a write tool. The bot posts, in the thread, the tool name and the exact arguments as plain text, and who can approve.
2. Only the member who asked can answer. They reply in the same thread, tagging the bot, with exactly one of `approve`, `yes`, `да`, `подтверждаю` to run it, or `cancel`, `no`, `нет`, `отмена` to drop it. Case and punctuation do not matter. A longer sentence is not a decision, it goes to the model like any other question.
3. The words are matched by the server, not by the model. The model is not asked.
4. The bot runs the tool once and posts the result with the link.

Example thread:

```text
Anna:  @Automation Bot create a Linear ticket for the billing bug
Bot:   I need approval to run `linear.createIssue` with exactly these arguments:
       {
         "title": "Billing bug",
         "description": "Checkout returns 500 for annual plans",
         "teamKey": "ENG"
       }
       Reply `@Automation Bot approve` or `@Automation Bot cancel` in this thread within 10 minutes. Only @Anna can approve.
Ben:   @Automation Bot approve
Bot:   Only U01ANNA can approve this.
Anna:  @Automation Bot approve
Bot:   Done. Created Linear issue ENG-231 "Billing bug": https://linear.app/acme/issue/ENG-231
Anna:  @Automation Bot approve
Bot:   Nothing is waiting for approval in this thread.
```

Rules the server enforces:

- **Rate limits apply.** `approve` and `cancel` go through the same limits as any other message, see [Rate limits](#rate-limits).
- **Same user only.** The member who made the request is the only one who can approve or cancel it. Another allowed member gets `Only <member ID> can approve this.` and nothing happens. The bot's own mention of the requester in the approval message is the only mention the bot ever writes. It is built from Slack's validated user ID, never from model or tool text.
- **Ten minutes.** After 10 minutes a request is expired. Approving it gets `This request expired.` and runs nothing.
- **Once.** The server marks the request approved with one atomic database update before running it, so two approvals sent together run the tool once. A second `approve` gets `Nothing is waiting for approval in this thread.`
- **One request per thread.** A new proposal in a thread cancels the one before it. A request is tied to its channel and thread and can never be approved from another.
- **Checked again at approval.** The arguments are validated again, and the tool is looked up in the current settings. If the integration was switched off in between, the bot says the tool is no longer available and runs nothing. A request that was approved but did not finish because the server stopped is not retried. If the server cannot record the result after the tool ran, for example during shutdown, the reply still says what was done and a warning is logged.
- **Retention.** Finished requests, and any request past its expiry, are deleted by the hourly prune after the same number of days as runs (`LOG_RETENTION_DAYS`, 30 by default).
- **Dry run.** A dry run stores nothing and writes nothing. It shows the proposal on the run page, and a dry-run approve reports `dry-run: would run <tool> <arguments>`.

Why the exact arguments are shown: the model can be steered by text it read (an issue, a comment, a Slack message). Approval is the control for that, and it only works if what you approve is exactly what runs. The bot therefore shows the validated arguments verbatim, escaped so they cannot ping anyone, and runs those same stored arguments. Read them before you approve, especially a title or body that came from something pasted into the thread.

### Turning approval off

The **Require approval for changes** field (`requireApproval`, on by default) controls this. When it is off, the bot validates the arguments and runs the write right away, replies with the result, and still logs it on the run as a write step (stage `executed`). Risk: anyone on the allowlist, and any text the bot reads, can then get issues created and workflows started with no human check. Leave it on unless the bot is only in a private channel of people you trust and the connected tokens can do little damage. The server logs a warning at startup while it is off.

## Model choice and cost

The bot uses the **Agent model** field of the Slack card. If it is empty it uses the **Escalation model** of the OpenRouter integration (`anthropic/claude-sonnet-5.5` by default). The model must support structured outputs, like the Crisp triage models.

Each question costs one to seven model calls, and each call carries the thread, the question and the tool results so far, up to a few thousand tokens. A typical question with one tool is two calls. Set a credit limit on the OpenRouter key, and use a cheaper model in **Agent model** if cost matters. Only listed members can trigger calls, so the allowlist is also your cost control.

## Treat everything the bot reads as untrusted

Issue bodies, comments, Sentry titles and other people's Slack messages can contain text written to trick an AI model ("ignore your instructions and ..."). The bot is built for that:

- The model is told that thread text and tool results are data, never instructions, and they are fenced in the prompt so they cannot close the fence.
- The model can only call the tools listed here. It has no shell and no arbitrary HTTP. A call to anything else is refused and counted as a step. A write tool is never run by the model's turn, it only produces a proposal that a person approves.
- Every tool result and every piece of thread text is redacted (tokens, emails, long secrets) before it goes into a prompt, and the same redaction is applied to what is logged.
- The answer is escaped before it is posted, so a hostile issue cannot make the bot ping `@channel` or a person. Links the model writes show as plain text and Slack still makes URLs clickable.

This lowers the risk. It does not remove it: a model can still repeat misleading text from an issue in its answer, and a hostile issue can still try to make it propose a change. That is why a change is never run on the model's say-so: you see the exact arguments and only the requester can approve. Read answers as you would read the issue itself.

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
      - users:read
      - channels:read
      - groups:read
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
- `channels:history` and `groups:history` let it read the thread it was tagged in (public and private channels). If you leave them out the bot still answers, but without the earlier messages of the thread. The run log then shows `could not read the thread, answering without it`.
- `users:read`, `channels:read` and `groups:read` let the admin list the people and channels of your workspace in the pickers (`groups:read` covers private channels). The bot itself never uses them. If you leave them out, the pickers show a missing-scope hint and you can still add IDs by hand (see [Add by ID](#add-by-id)).

Reinstall the app after adding scopes. Slack keeps the old token's permissions until you do.

3. Click **Create**. Slack checks the request URL right away. If the server is not reachable yet or the signing secret is not saved, the check fails. Save the secrets in step 2 first, then open **Event Subscriptions** and click **Retry**. The server answers the check on its own.

## 2. Install the app and paste the tokens

1. In the Slack app, open **Basic Information**, find **Signing Secret**, click **Show** and copy it.
2. Open **Install App**, click **Install to Workspace** and allow it. Copy the **Bot User OAuth Token**, which starts with `xoxb-`.
3. In the admin open **Integrations**, then the **Slack** card. The page has four sections: **Connection**, **Access**, **Alerts** and **Advanced**. Under **Connection** paste the bot token (env: `SLACK_BOT_TOKEN`) and the signing secret (env: `SLACK_SIGNING_SECRET`), and click **Save**. The pickers in **Access** stay disabled until the bot token is saved.

The card also shows the **Webhook URL** to use as the Slack request URL. It needs `PUBLIC_URL` on the server.

4. Click **Test connection**. It calls `auth.test` and shows the bot name and the workspace. It never shows the token, and it posts no message unless you also set the alert webhook.

The daily token check also calls `auth.test` for the bot token, and alerts when it stops working. It never posts the alert webhook's test message.

## 3. Choose users and channels

Once the bot token is saved, the **Access** section reads your live Slack directory. Nothing is typed by hand.

1. Click **Choose users**. A dialog lists the people of your workspace (no deactivated accounts, bots or Slackbot). Search by name or `@handle`, tick the people who may use the bot, click **Done**. They show as chips with their names. Remove one with its **x**.
2. Optional: click **Choose channels** to limit where the bot answers. Public and private channels are listed, and a channel the bot has not been invited to is marked `bot not invited`. **Allowed channels** empty means the bot answers in any channel it has been invited to. With channels chosen, a mention anywhere else is ignored: no reply, no model call. It still shows as a run with the decision `channel-not-allowed`.
3. Turn **Bot enabled** on. The route `/webhooks/<project>/slack` only exists while this is on.
4. Click **Save**. Choosing in the dialog changes nothing until you save the page.

Until at least one user is chosen the page shows `Nobody can use the bot yet. Choose at least one user.` Someone who is not chosen gets `You are not allowed to use this bot. Ask an admin to add you to the allowed users.` at most once every 10 minutes, and nothing at all in between. No model call, tool call or thread read happens for them. The check runs on every mention, so approving and cancelling a change obey it too.

The other fields:

| Field | Value |
| --- | --- |
| Agent model | Optional. An OpenRouter model id. Empty uses the OpenRouter escalation model. |
| Bot name | Optional. Shown in the approval message as `@name approve`. Empty uses the name Slack reports for the bot. |
| Require approval for changes | On by default. See [Turning approval off](#turning-approval-off). |

Set up OpenRouter (see [OpenRouter](openrouter.md)), and any service you want the bot to read: GitHub token and issues repository, Sentry auth token, PostHog, and the Linear **API key** ([Linear](linear.md)). Each one adds its tools.

### Add by ID

The lists come from Slack's `users.list`, `users.conversations` and `conversations.list`, read with the saved bot token on the server (the token never reaches the browser). If the pickers show an error, the dialog says why, for example which scope to add. A person the list cannot return, such as someone from another workspace in a Slack Connect channel, can still be added: in the dialog type the ID in **Add by ID** and click **Add**. To copy a member ID in Slack, open the profile, click the three dots (**More**) and choose **Copy member ID** (it looks like `U01ABCDEF23`). A channel ID (`C01ABCDEF23`, or `G...` for private ones) is at the bottom of the channel's **About** tab. An ID that is saved but not in the directory shows as the raw ID with `not found`. It is kept.

## Rate limits

The server limits the bot in memory, per project, so a loop or a flood cannot run up model cost. The limits reset when the server restarts.

| Rule | Limit | What the sender sees |
| --- | --- | --- |
| Allowed member | 6 requests a minute each. The allowance refills one request every 10 seconds. | One `You are sending requests too fast, wait a minute.` per member per minute. Further requests are dropped without a reply. |
| Member who is not allowed | The denial is sent at most once per member per 10 minutes. | The denial once, then nothing. |
| Concurrent runs | 4 at a time per project. | One `I am busy, try again in a minute.` per member per minute, then nothing. |

Normal use never reaches these limits. A dry run does not use up any allowance. A dropped mention still shows as a run on the Runs page with the decision `rate-limited`, `busy`, `denied` or `channel-not-allowed`.

## 4. Invite the bot and try it

Invite the bot to a channel (`/invite @Automation Bot`), then write `@Automation Bot what Linear issues mention billing?`. A chosen user gets the answer in a thread under the message. To continue, reply in that thread and tag the bot again: it reads the earlier messages as context.

Each mention is a run of the `slack-bot` automation on the **Runs** page. Open one to see who asked, the channel and the reply. Every tool call is a log line `agent step` with the tool name, the redacted arguments and how long it took. The run's outcome lists the final status (`answered`, `exhausted`, `failed`, `not-configured`, `pending-approval`, `executed`, `cancelled` or `expired`), the step count and the tools used. A change shows as a step on its run: `proposed` when the bot asked for approval, then `executed` (or `cancelled`) on the run of the reply that decided it. Results shown on the run never contain tokens. Slack retries an event it thinks was not delivered in time. The server uses the event ID as the claim, so a retry is shown as a `duplicate` run and does not reply twice.

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
- **A `crisp` fix workflow shows only an issue number.** Starting the Crisp fix workflow passes an `issue_number` input, so the approval message shows just that number. Open the issue and read it before you approve, because the workflow works from the issue text.
- **`requireApproval: false` removes the human check.** With it off, anyone on the allowlist, and any text the bot reads, can get issues created, labels added and allowed workflows started at once. See [Turning approval off](#turning-approval-off).
- **The pickers show at most 200 rows and read at most 5 pages of 200 from Slack.** A larger workspace shows a note. Use the search or **Add by ID**. The server keeps each list for 60 seconds, so a new colleague can take a minute to show up. **Refresh** in the dialog skips that cache.
- **Stored Slack events are redacted by key name and by secret shape only.** Keys such as `token`, `secret` or `key` are replaced, and values that look like a Slack, GitHub, OpenRouter, Linear or PostHog token, a bearer token, a JWT or a Slack webhook URL are replaced wherever they are. A secret in some other form, such as a password pasted in a sentence, is stored as written. Tell people not to paste secrets into Slack when they talk to the bot.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Slack says the request URL did not respond | The server is not public, `PUBLIC_URL` or the slug is wrong, **Bot enabled** is off, or the signing secret is missing. |
| `invalid_auth` in Test connection | The bot token is wrong or the app was reinstalled and the token rotated. |
| The bot never answers | It is not in the channel, the channel is not in **Allowed channels** (the run shows `channel-not-allowed` and nothing is posted), or the user is not in **Allowed users** (you get the denial then). |
| The picker says the app is missing a scope | Add `users:read`, `channels:read` and `groups:read` to the Slack app and reinstall it. Meanwhile use **Add by ID**. |
| The picker says Slack rejected the bot token | The token is wrong, revoked or from a reinstalled app. Paste the new one under **Connection**. |
| `channel_not_found` in the run error | The bot is not a member of that channel. Invite it. |
| `The AI model is not configured.` | The OpenRouter API key is not set. |
| `I could not do that: ... does not match the schema` | The Agent model does not support structured outputs. Pick another model. |
| The bot says it has no way to look something up | The service for that question has no tool: its token is not set, or for GitHub the **Issues repository** is empty. |
| The run log says `could not read the thread` | The app lacks `channels:history` or `groups:history`, or the bot is not in the channel. |

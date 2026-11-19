# Set up the Slack bot

This guide creates a Slack app that your team tags in a channel. In this first version the bot only answers `Got it: <your text>` in the thread, and only to members you list. It does not call a model or any other service yet. The setup below is the one the later versions reuse.

The bot is configured on the admin Integrations page, in the **Slack** card, next to the alert settings. The alert webhook is optional. You can run the bot without it, or the alerts without the bot.

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

`app_mentions:read` and `chat:write` are all this version uses. `channels:history` and `groups:history` let a later version read the thread it was tagged in, so granting them now avoids a reinstall.

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
| Bot name | Optional. Used in help text. |

4. Click **Save**, then **Test connection**. It calls `auth.test` and shows the bot name and the workspace. It never shows the token, and it posts no message unless you also set the alert webhook.

The card also shows the **Webhook URL** to use as the Slack request URL. It needs `PUBLIC_URL` on the server.

## 3. Find member IDs for the allowlist

In Slack, open the person's profile, click the three dots (**More**) and choose **Copy member ID**. It looks like `U01ABCDEF23`. Paste one ID per line into **Allowed users**.

## Rate limits

The server limits the bot in memory, per project, so a loop or a flood cannot run up model cost. The limits reset when the server restarts.

| Rule | Limit | What the sender sees |
| --- | --- | --- |
| Allowed member | 6 requests a minute each. The allowance refills one request every 10 seconds. | One `You are sending requests too fast, wait a minute.` per member per minute. Further requests are dropped without a reply. |
| Member who is not allowed | The denial is sent at most once per member per 10 minutes. | The denial once, then nothing. |
| Concurrent runs | 4 at a time per project. | One `I am busy, try again in a minute.` per member per minute, then nothing. |

Normal use never reaches these limits. A dry run does not use up any allowance. A dropped mention still shows as a run on the Runs page with the decision `rate-limited`, `busy` or `denied`.

## 4. Invite the bot and try it

Invite the bot to a channel (`/invite @Automation Bot`), then write `@Automation Bot hello`. A listed member gets `Got it: hello` in a thread under the message. Anyone else gets `You are not allowed to use this bot. Ask an admin to add your member ID.` at most once every 10 minutes and nothing else runs. See [Rate limits](#rate-limits).

Each mention is a run of the `slack-bot` automation on the **Runs** page. Open one to see who asked, the channel and the reply. Slack retries an event it thinks was not delivered in time. The server uses the event ID as the claim, so a retry is shown as a `duplicate` run and does not reply twice.

## What is checked and stored

- Every request must carry a valid `X-Slack-Signature` for the signing secret and a timestamp within five minutes. Otherwise the server answers `401` and runs nothing.
- Messages written by a bot, including this one, are ignored, so the bot cannot trigger itself.
- Text from Slack is escaped before it is echoed, so a message cannot make the bot ping `@channel` or a person.
- The message text is stored with the event so a run can be replayed. Stored events are redacted by key name only (keys such as `token` or `secret`), not by content, so a secret pasted into a message is stored as written. Tell people not to paste secrets to the bot.
- To rehearse without posting, replay the run as a dry run from its page. It logs what it would reply and posts nothing.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Slack says the request URL did not respond | The server is not public, `PUBLIC_URL` or the slug is wrong, **Bot enabled** is off, or the signing secret is missing. |
| `invalid_auth` in Test connection | The bot token is wrong or the app was reinstalled and the token rotated. |
| The bot never answers | It is not in the channel, or the member ID is not in **Allowed users** (you get the denial then). |
| `channel_not_found` in the run error | The bot is not a member of that channel. Invite it. |

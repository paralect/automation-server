# Set up Slack alerts

This guide connects a Slack channel to the admin so the server tells you when an automation keeps failing. For how the alert rule works and what the message contains, read [docs/integrations/slack.md](../integrations/slack.md).

The alerts need nothing from Slack to reach this server: the server posts to an incoming webhook, so there is no URL to paste into Slack. The [Slack bot](slack-bot.md) is different. Slack sends its events to this server, so the bot needs a public URL, and its settings live in the same card but are independent of the webhook. Everything is entered on the admin Integrations page, in the **Slack** card. You can also set the webhook URL with the environment variable `SLACK_ALERTS_WEBHOOK_URL`.

Before you start, make sure the server has `SETTINGS_ENCRYPTION_KEY` set. The admin refuses to save the webhook URL without it.

## 1. Create the Slack incoming webhook

A webhook URL is tied to one channel. If you already made one for the PostHog report, you can reuse the same Slack app and add a second webhook for the alerts channel.

1. Open [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**.
2. Choose **From scratch**. Name it `Automation alerts` and pick the workspace that owns the channel. Click **Create App**. You can also reuse an existing app and skip to step 3.
3. In the app's left sidebar, under **Features**, click **Incoming Webhooks**.
4. Turn the **Activate Incoming Webhooks** switch on.
5. Scroll down and click **Add New Webhook to Workspace**.
6. Pick the channel from the dropdown. For a private channel, invite the app to it first. Click **Allow**.
7. Back on **Incoming Webhooks**, find the new row under **Webhook URLs for Your Workspace** and click **Copy**. The URL looks like `https://hooks.slack.com/services/T000/B000/xxx`.

Treat the URL as a secret. Anyone who has it can post to the channel. Alerts quote the error of the failed run after secrets, emails and IP addresses are scrubbed, so pick a channel whose members may see that.

## 2. Fill in the admin

1. Open the admin and go to **Integrations**. Find the **Slack** card.
2. Fill in the fields.

| Field | Value |
| --- | --- |
| Alerts incoming webhook URL | The `https://hooks.slack.com/services/...` URL from step 1. It must start with `https://`. |
| Failure threshold | How many failures in a row trigger an alert. Default `3`, from 1 to 50. |
| Alert on token health | On by default. Alerts when a connected token stops working or is about to expire. Turn it off to keep only failure alerts. |
| Channel label | Optional. Shown in the alert text, for example `#alerts`. |

3. Click **Save**. The card shows **Configured** once the webhook URL is set.
4. Click **Test connection**. The channel receives the message `Automation server alerts are connected`. If nothing arrives, the result says why. The webhook URL is never shown in it.

## What triggers an alert

The server alerts once when an automation's streak of failed runs reaches the threshold. It alerts again only after a success resets the streak.

- With a threshold of 3, the third failure in a row posts one message. The fourth, fifth and every later failure post nothing.
- The first successful run ends the streak. Three new failures after it alert again.
- Duplicates, dry runs and runs that were interrupted by a server restart are not counted, and they do not end a streak.
- Each project has its own streaks and its own Slack settings.

## Token health alerts

Once a day, from 06:00 UTC, the server tests every configured integration and records the result. The integration tiles show a green, red or grey dot, when the last check ran, and "Expires in N days" or "Expired" when the token has a known expiry. The **Test** button on a tile runs the same check at once and records it.

With **Alert on token health** on, the channel gets one message when:

- A check that passed, or had never run, now fails. A token that already fails on its very first check alerts once.
- A token expires within 14 days. It alerts once for each expiry date.
- A token has already expired. This alerts once too.

While the state stays bad, nothing more is posted. A token that recovers and fails again alerts again. The message names the integration and project and never contains a token or the webhook URL.

Only GitHub fine-grained tokens, and an OpenRouter key that has an expiry, report when they expire. Sentry, Linear, Crisp and PostHog keys do not, so for them the check shows only whether the key still works. The Slack webhook is not part of the daily check because testing it posts a message.

To get run links in the message, set `ADMIN_PUBLIC_URL` on the server to the public address of the admin, for example `https://admin.example.com`.

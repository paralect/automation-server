import { createSlackBot, createSlackBotClient, postToSlack } from "@automation-server/automations";
import { createSlackSource } from "@automation-server/sources";

import { defineModule } from "../module";

export const slack = defineModule({
  id: "slack",
  build({ slack }, { log, fetch }) {
    if (!slack.configured) return {};
    const { botEnabled, botToken, signingSecret, allowedUsers = [], apiBaseUrl } = slack.values;
    if (!botEnabled || !botToken || !signingSecret) return {};
    if (allowedUsers.length === 0) log.warn("slack bot is on but no member IDs are allowed, so it will only answer with a denial");
    const client = createSlackBotClient({ token: botToken, apiBaseUrl, fetch });
    return {
      sources: [createSlackSource({ signingSecret })],
      automations: [createSlackBot({ client, allowedUsers })],
    };
  },
  testHasSideEffects: true,
  async test({ slack }, { fetch }) {
    const { webhookUrl, botToken, channelLabel, apiBaseUrl } = slack.values;
    const parts: string[] = [];
    const details: Record<string, string> = {};

    if (botToken) {
      const identity = await createSlackBotClient({ token: botToken, apiBaseUrl, fetch })
        .authTest()
        .catch((err: unknown) => err as Error);
      if (identity instanceof Error) return { ok: false, available: true, message: identity.message };
      parts.push(`Bot @${identity.botName} is connected to ${identity.team}`);
      details.bot = identity.botName;
      details.team = identity.team;
      details.webhook = "/webhooks/slack";
      details.botEnabled = slack.values.botEnabled ? "yes" : "no";
      details.allowedUsers = String(slack.values.allowedUsers?.length ?? 0);
      details.signingSecret = slack.values.signingSecret ? "set" : "missing";
    }

    if (webhookUrl) {
      await postToSlack(webhookUrl, "Automation server alerts are connected", { fetch });
      parts.push(`Test message sent to Slack${channelLabel ? ` ${channelLabel}` : ""}`);
    }

    if (parts.length === 0) return { ok: false, available: true, message: "Slack webhook URL is not set" };
    return { ok: true, available: true, message: parts.join(". "), ...(Object.keys(details).length > 0 ? { details } : {}) };
  },
});

import {
  buildReadTools,
  createAgent,
  createAgentHandler,
  createOpenRouterClient,
  createSlackBot,
  createSlackBotClient,
  postToSlack,
} from "@automation-server/automations";
import { createSlackSource } from "@automation-server/sources";
import { parseRepo, type ResolvedConfig } from "@automation-server/settings";

import { defineModule } from "../module";

type Deps = { fetch?: typeof fetch };

// The read tools need only the token of each service, not its webhook settings, so a team can give the bot Linear or Sentry access without wiring their webhooks.
function readTools({ github, sentry, posthog, linear }: ResolvedConfig, { fetch }: Deps) {
  const { authToken, apiBaseUrl } = sentry.values;
  const { apiKey } = linear.values;
  return buildReadTools({
    github: github.configured && github.values.repo ? { token: github.values.token, repo: parseRepo(github.values.repo) } : undefined,
    sentry: authToken ? { authToken, apiBaseUrl: apiBaseUrl ?? "https://sentry.io" } : undefined,
    posthog: posthog.configured ? posthog.values : undefined,
    linear: apiKey ? { apiKey } : undefined,
    fetch,
  });
}

export const slack = defineModule({
  id: "slack",
  build(config, { log, fetch }) {
    const { slack, openrouter } = config;
    if (!slack.configured) return {};
    const { botEnabled, botToken, signingSecret, allowedUsers = [], apiBaseUrl, agentModel } = slack.values;
    if (!botEnabled || !botToken || !signingSecret) return {};
    if (allowedUsers.length === 0) log.warn("slack bot is on but no member IDs are allowed, so it will only answer with a denial");

    const tools = readTools(config, { fetch });
    const agent = createAgent({
      model: openrouter.configured ? createOpenRouterClient({ apiKey: openrouter.values.apiKey, fetch }) : null,
      modelName: agentModel || openrouter.values.escalationModel || "anthropic/claude-sonnet-5.5",
      tools,
    });
    log.info("slack bot ready", { tools: tools.map((t) => t.name), model: openrouter.configured ? "configured" : "missing" });

    const client = createSlackBotClient({ token: botToken, apiBaseUrl, fetch });
    return {
      sources: [createSlackSource({ signingSecret })],
      automations: [createSlackBot({ client, allowedUsers, handler: createAgentHandler(agent) })],
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

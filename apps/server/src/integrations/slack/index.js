import { buildReadTools, buildWriteTools, createAgent, createAgentHandler, createOpenRouterClient, createSlackBot, createSlackBotClient, postToSlack, } from "@automation-server/automations";
import { createSlackSource } from "@automation-server/sources";
import { parseRepo } from "@automation-server/settings";
import { defineModule } from "../module";
// The read tools need only the token of each service, not its webhook settings, so a team can give the bot Linear or Sentry access without wiring their webhooks.
function readTools({ github, sentry, posthog, linear }, { fetch }) {
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
// Only a workflow the project configured for its own automations, living in the repository the bot dispatches in, may be started from Slack.
function allowedWorkflows({ github, linear, crisp }) {
    const repo = github.configured ? github.values.repo?.trim().toLowerCase() : undefined;
    const files = new Set();
    if (crisp.configured)
        files.add(crisp.values.workflowFile);
    if (linear.configured && linear.values.targetRepo.trim().toLowerCase() === repo)
        files.add(linear.values.workflowFile);
    return [...files].filter(Boolean);
}
function workflowRefs({ linear }) {
    if (!linear.configured)
        return {};
    const { ref, workflowFile } = linear.values;
    return ref.trim() ? { [workflowFile]: ref.trim() } : {};
}
function writeTools(config, { fetch }) {
    const { github, linear } = config;
    const { apiKey } = linear.values;
    return buildWriteTools({
        github: github.configured && github.values.repo ? { token: github.values.token, repo: parseRepo(github.values.repo), workflowFiles: allowedWorkflows(config), workflowRefs: workflowRefs(config) } : undefined,
        linear: apiKey ? { apiKey, triggerLabel: linear.configured ? linear.values.triggerLabel : undefined } : undefined,
        fetch,
    });
}
export const slack = defineModule({
    id: "slack",
    build(config, { log, fetch, pending, project }) {
        const { slack, openrouter } = config;
        if (!slack.configured)
            return {};
        const { botEnabled, botToken, signingSecret, allowedUsers = [], allowedChannels = [], apiBaseUrl, agentModel, botName, requireApproval } = slack.values;
        if (!botEnabled || !botToken || !signingSecret)
            return {};
        if (allowedUsers.length === 0)
            log.warn("slack bot is on but no users are allowed, so it will only answer with a denial");
        const canWrite = pending !== undefined && project !== undefined;
        if (!requireApproval)
            log.warn("slack bot approval is off: writes run as soon as the model proposes them");
        const tools = [...readTools(config, { fetch }), ...(canWrite ? writeTools(config, { fetch }) : [])];
        const agent = createAgent({
            model: openrouter.configured ? createOpenRouterClient({ apiKey: openrouter.values.apiKey, fetch }) : null,
            modelName: agentModel || openrouter.values.escalationModel || "anthropic/claude-sonnet-5.5",
            tools,
        });
        log.info("slack bot ready", { tools: tools.map((t) => t.name), requireApproval, model: openrouter.configured ? "configured" : "missing" });
        const client = createSlackBotClient({ token: botToken, apiBaseUrl, fetch });
        return {
            sources: [createSlackSource({ signingSecret })],
            automations: [createSlackBot({ client, allowedUsers, allowedChannels, handler: createAgentHandler(agent, canWrite ? { pending, project, tools, requireApproval, botName } : undefined) })],
        };
    },
    scheduledCheck: ({ slack }) => Boolean(slack.values.botToken),
    async test({ slack }, { fetch }, options) {
        const { webhookUrl, botToken, channelLabel, apiBaseUrl } = slack.values;
        const parts = [];
        const details = {};
        if (botToken) {
            const identity = await createSlackBotClient({ token: botToken, apiBaseUrl, fetch })
                .authTest()
                .catch((err) => err);
            if (identity instanceof Error)
                return { ok: false, available: true, message: identity.message };
            parts.push(`Bot @${identity.botName} is connected to ${identity.team}`);
            details.bot = identity.botName;
            details.team = identity.team;
            details.webhook = "/webhooks/slack";
            details.botEnabled = slack.values.botEnabled ? "yes" : "no";
            details.allowedUsers = String(slack.values.allowedUsers?.length ?? 0);
            details.allowedChannels = slack.values.allowedChannels?.length ? String(slack.values.allowedChannels.length) : "any";
            details.signingSecret = slack.values.signingSecret ? "set" : "missing";
        }
        // The daily token check only verifies the bot token. Posting the test message is for a person clicking the button.
        if (webhookUrl && !options?.scheduled) {
            await postToSlack(webhookUrl, "Automation server alerts are connected", { fetch });
            parts.push(`Test message sent to Slack${channelLabel ? ` ${channelLabel}` : ""}`);
        }
        if (parts.length === 0)
            return { ok: false, available: true, message: "Slack webhook URL is not set" };
        return { ok: true, available: true, message: parts.join(". "), ...(Object.keys(details).length > 0 ? { details } : {}) };
    },
});

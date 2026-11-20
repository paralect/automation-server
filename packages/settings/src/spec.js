// slackUsers and slackChannels store a plain list of Slack IDs. Only the admin renders them as pickers.
export const isListKind = (kind) => kind === "list" || kind === "slackUsers" || kind === "slackChannels";
export const REPO_PATTERN = "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$";
export const INTEGRATIONS = {
    github: {
        id: "github",
        title: "GitHub",
        description: "Token used to create issues, read Actions runs, dispatch workflows and install workflow files.",
        fields: [
            { key: "token", label: "Token", kind: "secret", required: true, env: "GITHUB_TOKEN", help: "Fine-grained token. Grant the access the features you use need: Issues, Actions, Contents, Pull requests, Workflows." },
            { key: "repo", label: "Issues repository", kind: "text", env: "GITHUB_REPO", pattern: REPO_PATTERN, help: "owner/name. Where Sentry alerts become issues." },
            { key: "actionsRepos", label: "Actions repositories", kind: "list", env: "GITHUB_ACTIONS_REPOS", pattern: REPO_PATTERN, help: "owner/name entries whose Actions runs the admin shows. Empty means the issues repository." },
        ],
    },
    sentry: {
        id: "sentry",
        title: "Sentry",
        description: "Turns Sentry issue alerts into GitHub issues.",
        webhookSource: "sentry",
        fields: [
            { key: "clientSecret", label: "Client secret", kind: "secret", required: true, env: "SENTRY_CLIENT_SECRET", help: "Client Secret of the Sentry internal integration. Verifies webhook signatures." },
            { key: "authToken", label: "Auth token", kind: "secret", env: "SENTRY_AUTH_TOKEN", help: "Issue & Event: Read. Enables issue stats enrichment." },
            { key: "apiBaseUrl", label: "API base URL", kind: "text", default: "https://sentry.io", env: "SENTRY_API_BASE_URL" },
            { key: "levels", label: "Levels", kind: "list", default: ["error", "fatal"], env: "SENTRY_LEVELS", help: "Sentry levels that create a GitHub issue." },
            { key: "environments", label: "Environments", kind: "list", env: "SENTRY_ENVIRONMENTS", help: "Empty means all environments." },
            { key: "minEventCount", label: "Minimum event count", kind: "number", default: 1, min: 0, env: "SENTRY_MIN_EVENT_COUNT", help: "Only applied when the count is known (needs the auth token)." },
        ],
    },
    linear: {
        id: "linear",
        title: "Linear",
        description: "Implements a Linear issue and opens a PR when the trigger label is added.",
        webhookSource: "linear",
        fields: [
            { key: "webhookSecret", label: "Webhook secret", kind: "secret", required: true, help: "Signing secret of the Linear webhook." },
            { key: "triggerLabel", label: "Trigger label", kind: "text", required: true, help: "Adding this label to an issue starts the implementation." },
            { key: "targetRepo", label: "Target repository", kind: "text", required: true, pattern: REPO_PATTERN, help: "owner/name. Must have the workflow installed." },
            { key: "workflowFile", label: "Workflow file", kind: "text", default: "linear-implement.yml" },
            { key: "ref", label: "Ref", kind: "text", default: "", help: "Branch to run the workflow on. Empty means the repository default branch." },
            { key: "apiKey", label: "API key", kind: "secret", env: "LINEAR_API_KEY", help: "Personal API key (Settings, Security & access). Lets the Slack bot search and read issues. Leave empty to keep it off." },
        ],
    },
    posthog: {
        id: "posthog",
        title: "PostHog",
        description: "Sends a weekly PostHog report to Slack.",
        fields: [
            { key: "host", label: "Host", kind: "text", required: true, default: "https://us.posthog.com" },
            { key: "projectId", label: "Project ID", kind: "text", required: true },
            { key: "personalApiKey", label: "Personal API key", kind: "secret", required: true, help: "Needs query read access." },
            { key: "enabled", label: "Enabled", kind: "boolean", default: false },
            { key: "dayOfWeek", label: "Day of week", kind: "number", default: 1, min: 0, max: 6, help: "0 is Sunday." },
            { key: "hourUtc", label: "Hour (UTC)", kind: "number", default: 9, min: 0, max: 23 },
            { key: "slackWebhookUrl", label: "Slack webhook URL", kind: "secret", required: true },
            { key: "reportTitle", label: "Report title", kind: "text", default: "Weekly PostHog report" },
        ],
    },
    openrouter: {
        id: "openrouter",
        title: "OpenRouter",
        description: "LLM access for automations that classify text, such as Crisp triage.",
        fields: [
            { key: "apiKey", label: "API key", kind: "secret", required: true, help: "An OpenRouter API key. Set a credit limit on it." },
            { key: "triageModel", label: "Triage model", kind: "text", default: "anthropic/claude-haiku-5.5", help: "Fast model for the first pass. Must support structured outputs." },
            { key: "escalationModel", label: "Escalation model", kind: "text", default: "anthropic/claude-sonnet-5.5", help: "Stronger model for bugs and unsure verdicts." },
        ],
    },
    crisp: {
        id: "crisp",
        title: "Crisp",
        description: "Triages Crisp conversations into a private note, a GitHub issue or a Codex fix.",
        webhookSource: "crisp",
        fields: [
            { key: "websiteId", label: "Website ID", kind: "text", required: true },
            { key: "pluginIdentifier", label: "Plugin token identifier", kind: "text", required: true, help: "From the plugin's production token in the Crisp Marketplace." },
            { key: "pluginKey", label: "Plugin token key", kind: "secret", required: true, help: "Needs conversation read and write scopes." },
            { key: "webhookSecret", label: "Web Hooks signing secret", kind: "secret", required: true, help: "Verifies X-Crisp-Signature." },
            { key: "triggerSegment", label: "Trigger segment", kind: "text", default: "triage", help: "Adding this segment to a conversation starts the triage." },
            { key: "autoTriage", label: "Triage resolved conversations", kind: "boolean", default: false, help: "Also triage every conversation marked resolved." },
            { key: "mode", label: "Mode", kind: "select", options: ["shadow", "issue", "fix", "dry-run"], default: "shadow", help: "shadow only posts a note. issue also opens GitHub issues. fix also starts the Codex fix workflow. dry-run does everything fix would, but writes nothing to Crisp or GitHub: each run shows what it would have done on its Runs page." },
            { key: "minConfidence", label: "Minimum confidence", kind: "number", default: 0.7, min: 0, max: 1, help: "Below this the verdict becomes needs_info." },
            { key: "areas", label: "Product areas", kind: "list", help: "The closed list of areas the classifier picks from." },
            { key: "autofixAreas", label: "Autofix areas", kind: "list", help: "Areas whose bugs may go to the Codex fix workflow. Empty means none." },
            { key: "workflowFile", label: "Workflow file", kind: "text", default: "codex-issue-fix.yml" },
        ],
    },
    slack: {
        id: "slack",
        title: "Slack",
        description: "Alerts when an automation keeps failing, and a bot you tag in Slack.",
        webhookSource: "slack",
        requiredOneOf: [["botToken", "signingSecret"], ["webhookUrl"]],
        fields: [
            { key: "botToken", label: "Bot token", kind: "secret", group: "Connection", groupHelp: "From your Slack app. Save these first, then choose who can use the bot.", env: "SLACK_BOT_TOKEN", pattern: "^xoxb-", help: "Bot User OAuth Token (xoxb-...) of your Slack app. Needed for the bot." },
            { key: "signingSecret", label: "Signing secret", kind: "secret", group: "Connection", env: "SLACK_SIGNING_SECRET", help: "Signing Secret of your Slack app. Verifies that events come from Slack." },
            { key: "botEnabled", label: "Bot enabled", kind: "boolean", group: "Access", groupHelp: "Who can use the bot, and where.", default: false, help: "Lets people tag the bot. It only answers the users chosen below." },
            { key: "allowedUsers", label: "Allowed users", kind: "slackUsers", group: "Access", pattern: "^[UW][A-Z0-9]+$", help: "Members allowed to use the bot. Nobody is allowed until you choose at least one." },
            { key: "allowedChannels", label: "Allowed channels", kind: "slackChannels", group: "Access", pattern: "^[CG][A-Z0-9]+$", help: "Channels where the bot answers. Empty means any channel the bot has been invited to. Mentions elsewhere are ignored without a reply." },
            { key: "requireApproval", label: "Require approval for changes", kind: "boolean", group: "Access", default: true, help: "When on, the bot shows the exact arguments of every change it wants to make and runs it only after the requester replies approve in the thread. Turn it off only if you accept that anyone on the allowlist, and any text the bot reads, can steer it into creating issues and starting workflows." },
            { key: "webhookUrl", label: "Alerts webhook URL", kind: "secret", group: "Alerts", groupHelp: "Optional. Posts a message when an automation keeps failing or a token stops working.", env: "SLACK_ALERTS_WEBHOOK_URL", pattern: "^https://", patternHint: "must start with https://", help: "An incoming webhook of the channel that should receive alerts. Leave empty to send no alerts." },
            { key: "failureThreshold", label: "Failure threshold", kind: "number", group: "Alerts", default: 3, min: 1, max: 50, help: "Alert once when an automation fails this many times in a row. It alerts again only after a success resets the streak." },
            { key: "alertOnTokenHealth", label: "Alert on token health", kind: "boolean", group: "Alerts", default: true, help: "Also alert when a connected token stops working or is about to expire." },
            { key: "channelLabel", label: "Channel label", kind: "text", group: "Alerts", help: "Shown in the alert text, for example #alerts." },
            { key: "agentModel", label: "Agent model", kind: "text", group: "Advanced", help: "OpenRouter model that answers the bot. Empty uses the OpenRouter escalation model. Must support structured outputs." },
            { key: "botName", label: "Bot name", kind: "text", group: "Advanced", help: "Shown in the approval message as @name approve, for example Automation Bot." },
            { key: "apiBaseUrl", label: "API base URL", kind: "text", group: "Advanced", default: "https://slack.com/api", pattern: "^https://", patternHint: "must start with https://", help: "Change only to reach a proxy or a test double." },
        ],
    },
};
export const INTEGRATION_IDS = Object.keys(INTEGRATIONS);
export const specOf = (id) => INTEGRATIONS[id];
export const isIntegrationId = (id) => Object.hasOwn(INTEGRATIONS, id);

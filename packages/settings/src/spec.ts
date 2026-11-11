export type FieldKind = "text" | "secret" | "number" | "boolean" | "select" | "list";

export type FieldSpec = {
  readonly key: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly required?: boolean;
  readonly default?: string | number | boolean | readonly string[];
  readonly help?: string;
  readonly options?: readonly string[];
  readonly env?: string;
  readonly pattern?: string;
  readonly min?: number;
  readonly max?: number;
};

export type IntegrationSpec = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly webhookSource?: string;
  readonly fields: readonly FieldSpec[];
};

const REPO_PATTERN = "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$";

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
} as const satisfies Record<string, IntegrationSpec>;

export type Integrations = typeof INTEGRATIONS;
export type IntegrationId = keyof Integrations;
export const INTEGRATION_IDS = Object.keys(INTEGRATIONS) as IntegrationId[];

type FieldValue<F> = F extends { kind: "number" }
  ? number
  : F extends { kind: "boolean" }
    ? boolean
    : F extends { kind: "list" }
      ? string[]
      : string;

type HasValue<F> = F extends { required: true } ? true : F extends { default: unknown } ? true : false;

type Fields<I extends IntegrationId> = Integrations[I]["fields"][number];

export type IntegrationValues<I extends IntegrationId> = {
  [F in Fields<I> as HasValue<F> extends true ? F["key"] : never]: FieldValue<F>;
} & {
  [F in Fields<I> as HasValue<F> extends true ? never : F["key"]]?: FieldValue<F>;
};

export const specOf = (id: IntegrationId): IntegrationSpec => INTEGRATIONS[id];

export const isIntegrationId = (id: string): id is IntegrationId => Object.hasOwn(INTEGRATIONS, id);

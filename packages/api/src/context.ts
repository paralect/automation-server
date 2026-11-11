import type { ActivityStore } from "@automation-server/core";
import type { ConnectionTestResult, EnvSource, IntegrationId, SettingsDb } from "@automation-server/settings";

import type { ActionsReader } from "./githubActions";
import type { WorkflowInstaller } from "./workflowInstaller";

/** Server state, with the sources, automations, jobs and webhook URLs of one project. */
export type SystemInfo = {
  startedAt: string;
  sources: string[];
  automations: string[];
  jobs: string[];
  retentionDays: number;
  /** Webhook URL per source name. Absolute when PUBLIC_URL is set, otherwise a path such as `/webhooks/<project>/sentry`. */
  webhookUrls: Record<string, string>;
};

export type SettingsAdmin = {
  db: SettingsDb;
  /** Process environment. Only the default project falls back to it. */
  env: EnvSource;
  /** Called after every successful settings or project write. Rebuilds the runtime from the new settings. */
  reload(): void;
  test(project: string, id: IntegrationId): Promise<ConnectionTestResult>;
};

export type PosthogPreview =
  | { readonly ok: true; readonly text: string; readonly generatedAt: string }
  | { readonly ok: false; readonly message: string };

export type PosthogRunResult =
  | { readonly status: "succeeded" | "failed"; readonly runId: string | null; readonly key: string; readonly message: string }
  | { readonly status: "busy" | "not-configured"; readonly message: string };

export type PosthogAdmin = {
  /** Builds the report text from live PostHog data without sending it. */
  preview(project: string): Promise<PosthogPreview>;
  /** Builds and sends the report now under a `manual:<timestamp>` key, recorded as a run. */
  runNow(project: string): Promise<PosthogRunResult>;
};

export type Context = {
  activity: ActivityStore;
  actions: (project: string) => ActionsReader;
  /** Built from the project's current GitHub settings on every call, so a saved token applies at once. */
  workflows: (project: string) => WorkflowInstaller;
  system: (project: string) => SystemInfo;
  settings: SettingsAdmin;
  posthog: PosthogAdmin;
  adminToken: string | undefined;
  bearer: string | undefined;
};

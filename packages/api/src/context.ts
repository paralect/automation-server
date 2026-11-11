import type { ActivityStore } from "@automation-server/core";
import type { ConnectionTestResult, EnvSource, IntegrationId, SettingsStore } from "@automation-server/settings";

import type { ActionsReader } from "./githubActions";
import type { WorkflowInstaller } from "./workflowInstaller";

export type SystemInfo = {
  startedAt: string;
  sources: string[];
  automations: string[];
  jobs: string[];
  retentionDays: number;
  /** Webhook URL per source name. Absolute when PUBLIC_URL is set, otherwise a path such as `/webhooks/sentry`. */
  webhookUrls: Record<string, string>;
};

export type SettingsAdmin = {
  store: SettingsStore;
  env: EnvSource;
  /** Called after every successful settings write. Rebuilds the runtime from the new settings. */
  reload(): void;
  test(id: IntegrationId): Promise<ConnectionTestResult>;
};

export type Context = {
  activity: ActivityStore;
  actions: () => ActionsReader;
  /** Built from the current GitHub settings on every call, so a saved token applies at once. */
  workflows: () => WorkflowInstaller;
  system: () => SystemInfo;
  settings: SettingsAdmin;
  adminToken: string | undefined;
  bearer: string | undefined;
};

import type { ActivityStore } from "@automation-server/core";
import type { ConnectionTestResult, EnvSource, IntegrationId, SettingsDb } from "@automation-server/settings";

import type { ActionsReader } from "./githubActions";
import type { WorkflowInstaller } from "./workflowInstaller";

export type SystemInfo = {
  startedAt: string;
  sources: string[];
  automations: string[];
  jobs: string[];
  retentionDays: number;
  webhookUrls: Record<string, string>;
};

export type SettingsAdmin = {
  db: SettingsDb;
  env: EnvSource;
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
  preview(project: string): Promise<PosthogPreview>;
  runNow(project: string): Promise<PosthogRunResult>;
};

export type Context = {
  activity: ActivityStore;
  actions: (project: string) => ActionsReader;
  workflows: (project: string) => WorkflowInstaller;
  system: (project: string) => SystemInfo;
  settings: SettingsAdmin;
  posthog: PosthogAdmin;
  adminToken: string | undefined;
  bearer: string | undefined;
};

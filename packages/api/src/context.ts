import type { ActivityStore, ReplayRequest, ReplayResult } from "@automation-server/core";
import type { LedgerReader, SyncNowResult } from "@automation-server/ledger";
import type { ConnectionTestResult, EnvSource, IntegrationId, SettingsDb, StoredHealth } from "@automation-server/settings";

import type { ActionsReader } from "./githubActions";
import type { SlackDirectory } from "./slackDirectory";
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
  health(project: string): Readonly<Record<string, StoredHealth>>;
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

export type ReplayJobResult =
  | { readonly status: "started"; readonly runId: string | null }
  | { readonly status: "busy" | "duplicate" | "unknown-job" };

export type ReplayAdmin = {
  event(request: ReplayRequest): Promise<ReplayResult>;
  job(project: string, automation: string, key: string, replayOf: string): Promise<ReplayJobResult>;
};

export type OutcomesAdmin = {
  syncNow(project: string): Promise<SyncNowResult>;
};

export type Context = {
  activity: ActivityStore;
  ledger: LedgerReader;
  outcomes: OutcomesAdmin;
  actions: (project: string) => ActionsReader;
  workflows: (project: string) => WorkflowInstaller;
  system: (project: string) => SystemInfo;
  settings: SettingsAdmin;
  posthog: PosthogAdmin;
  replay: ReplayAdmin;
  slackDirectory: SlackDirectory;
  adminToken: string | undefined;
  bearer: string | undefined;
};

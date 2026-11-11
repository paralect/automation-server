import type { ActivityStore } from "@automation-server/core";
import type { ConnectionTestResult, EnvSource, IntegrationId, SettingsStore } from "@automation-server/settings";

import type { ActionsReader } from "./githubActions";

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

export type PosthogPreview =
  | { readonly ok: true; readonly text: string; readonly generatedAt: string }
  | { readonly ok: false; readonly message: string };

export type PosthogRunResult =
  | { readonly status: "succeeded" | "failed"; readonly runId: string | null; readonly key: string; readonly message: string }
  | { readonly status: "busy" | "not-configured"; readonly message: string };

export type PosthogAdmin = {
  /** Builds the report text from live PostHog data without sending it. */
  preview(): Promise<PosthogPreview>;
  /** Builds and sends the report now under a `manual:<timestamp>` key, recorded as a run. */
  runNow(): Promise<PosthogRunResult>;
};

export type Context = {
  activity: ActivityStore;
  actions: () => ActionsReader;
  system: () => SystemInfo;
  settings: SettingsAdmin;
  posthog: PosthogAdmin;
  adminToken: string | undefined;
  bearer: string | undefined;
};

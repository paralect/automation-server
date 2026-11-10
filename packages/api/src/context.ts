import type { ActivityStore } from "@automation-server/core";

import type { ActionsReader } from "./githubActions";

export type SystemInfo = {
  startedAt: string;
  sources: string[];
  automations: string[];
  retentionDays: number;
};

export type Context = {
  activity: ActivityStore;
  actions: ActionsReader;
  system: SystemInfo;
  adminToken: string | undefined;
  bearer: string | undefined;
};

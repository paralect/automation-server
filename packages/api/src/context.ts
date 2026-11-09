import type { ActivityStore } from "@automation-server/core";

export type SystemInfo = {
  startedAt: string;
  sources: string[];
  automations: string[];
  retentionDays: number;
};

export type Context = {
  activity: ActivityStore;
  system: SystemInfo;
  adminToken: string | undefined;
  bearer: string | undefined;
};

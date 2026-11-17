import type { Context as ApiContext, PosthogAdmin, SettingsAdmin, SystemInfo } from "@automation-server/api/context";
import type { ActionsReader } from "@automation-server/api/githubActions";
import type { WorkflowInstaller } from "@automation-server/api/workflowInstaller";
import type { ActivityStore } from "@automation-server/core";
import type { Context as HonoContext } from "hono";

export type AdminDeps = {
  activity: ActivityStore;
  actions: (project: string) => ActionsReader;
  workflows: (project: string) => WorkflowInstaller;
  system: (project: string) => SystemInfo;
  settings: SettingsAdmin;
  posthog: PosthogAdmin;
  adminToken: string | undefined;
};

export type CreateContextOptions = AdminDeps & {
  context: HonoContext;
};

export function createContext({ context, activity, actions, workflows, system, settings, posthog, adminToken }: CreateContextOptions): ApiContext {
  const match = /^Bearer\s+(.+)$/i.exec(context.req.header("authorization") ?? "");
  return { activity, actions, workflows, system, settings, posthog, adminToken, bearer: match?.[1]?.trim() };
}

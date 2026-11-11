import type { Context as ApiContext, SettingsAdmin, SystemInfo } from "@automation-server/api/context";
import type { ActionsReader } from "@automation-server/api/githubActions";
import type { WorkflowInstaller } from "@automation-server/api/workflowInstaller";
import type { ActivityStore } from "@automation-server/core";
import type { Context as HonoContext } from "hono";

export type AdminDeps = {
  activity: ActivityStore;
  actions: () => ActionsReader;
  workflows: () => WorkflowInstaller;
  system: () => SystemInfo;
  settings: SettingsAdmin;
  adminToken: string | undefined;
};

export type CreateContextOptions = AdminDeps & {
  context: HonoContext;
};

export async function createContext({ context, activity, actions, workflows, system, settings, adminToken }: CreateContextOptions): Promise<ApiContext> {
  const match = /^Bearer\s+(.+)$/i.exec(context.req.header("authorization") ?? "");
  return { activity, actions, workflows, system, settings, adminToken, bearer: match?.[1]?.trim() };
}

export type Context = Awaited<ReturnType<typeof createContext>>;

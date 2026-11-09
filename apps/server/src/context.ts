import type { Context as ApiContext, SystemInfo } from "@automation-server/api/context";
import type { ActivityStore } from "@automation-server/core";
import type { Context as HonoContext } from "hono";

export type AdminDeps = {
  activity: ActivityStore;
  system: SystemInfo;
  adminToken: string | undefined;
};

export type CreateContextOptions = AdminDeps & {
  context: HonoContext;
};

export async function createContext({ context, activity, system, adminToken }: CreateContextOptions): Promise<ApiContext> {
  const match = /^Bearer\s+(.+)$/i.exec(context.req.header("authorization") ?? "");
  return { activity, system, adminToken, bearer: match?.[1]?.trim() };
}

export type Context = Awaited<ReturnType<typeof createContext>>;

import type { Context as ApiContext } from "@automation-server/api/context";
import type { Context as HonoContext } from "hono";

export type AdminDeps = Omit<ApiContext, "bearer">;

export type CreateContextOptions = AdminDeps & {
  context: HonoContext;
};

export function createContext({ context, ...deps }: CreateContextOptions): ApiContext {
  const match = /^Bearer\s+(.+)$/i.exec(context.req.header("authorization") ?? "");
  return { ...deps, bearer: match?.[1]?.trim() };
}

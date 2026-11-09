import type {
  ActivityStats,
  Page,
  RunRecord,
  StoredLog,
  StoredRun,
} from "@automation-server/core";
import { ORPCError, type, type RouterClient } from "@orpc/server";
import { z } from "zod";

import { adminProcedure, o } from "../index";
import type { SystemInfo } from "../context";

const level = z.enum(["info", "warn", "error"]);
const status = z.enum(["running", "succeeded", "failed", "duplicate"]);
const page = { before: z.number().int().optional(), limit: z.number().int().min(1).max(200).default(50) };
const text = z.string().trim().min(1).max(200).optional();

export const appRouter = {
  healthCheck: o.handler(() => "OK"),

  overview: adminProcedure
    .input(z.object({ windowHours: z.number().int().min(1).max(168).default(24) }))
    .output(type<ActivityStats>())
    .handler(({ input, context }) => {
      const windowMs = input.windowHours * 3_600_000;
      const bucketMs = input.windowHours <= 24 ? 3_600_000 : 6 * 3_600_000;
      return context.activity.stats(new Date(Date.now() - windowMs).toISOString(), bucketMs);
    }),

  logs: {
    list: adminProcedure
      .input(z.object({ level: level.optional(), source: text, automation: text, runId: text, search: text, ...page }))
      .output(type<Page<StoredLog>>())
      .handler(({ input, context }) => context.activity.queryLogs(input)),
  },

  runs: {
    list: adminProcedure
      .input(z.object({ status: status.optional(), automation: text, source: text, search: text, ...page }))
      .output(type<Page<StoredRun>>())
      .handler(({ input, context }) => context.activity.queryRuns(input)),
    get: adminProcedure
      .input(z.object({ id: z.string().min(1) }))
      .output(type<{ run: RunRecord; logs: StoredLog[] }>())
      .handler(({ input, context }) => {
        const found = context.activity.getRun(input.id);
        if (!found) throw new ORPCError("NOT_FOUND");
        return found;
      }),
  },

  system: adminProcedure
    .output(type<SystemInfo & { uptimeSeconds: number }>())
    .handler(({ context }) => ({
      ...context.system,
      uptimeSeconds: Math.floor((Date.now() - Date.parse(context.system.startedAt)) / 1000),
    })),
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;

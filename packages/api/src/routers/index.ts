import type {
  ActivityStats,
  Page,
  RunRecord,
  StoredLog,
  StoredRun,
} from "@automation-server/core";
import {
  describeSettings,
  INTEGRATION_IDS,
  planUpdate,
  resolveConfig,
  SecretsUnavailableError,
  SettingsInputError,
  type ConnectionTestResult,
  type SettingsView,
} from "@automation-server/settings";
import { ORPCError, type, type RouterClient } from "@orpc/server";
import { z } from "zod";

import { adminProcedure, o } from "../index";
import type { Context, PosthogPreview, PosthogRunResult, SystemInfo } from "../context";
import { ACTION_STATES, type ActionsRunList, type WorkflowJob, type WorkflowRun } from "../githubActions";

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

  actions: {
    list: adminProcedure
      .input(
        z.object({
          repo: text,
          workflow: text,
          state: z.enum(ACTION_STATES).optional(),
          page: z.number().int().min(1).max(50).default(1),
        }),
      )
      .output(type<ActionsRunList>())
      .handler(({ input, context }) => context.actions().listRuns(input)),
    get: adminProcedure
      .input(z.object({ repo: z.string().min(3).max(200), id: z.number().int().positive() }))
      .output(type<{ run: WorkflowRun; jobs: WorkflowJob[] }>())
      .handler(async ({ input, context }) => {
        let found: Awaited<ReturnType<ReturnType<typeof context.actions>["getRun"]>>;
        try {
          found = await context.actions().getRun(input.repo, input.id);
        } catch (err) {
          throw new ORPCError("BAD_GATEWAY", { message: err instanceof Error ? err.message : "GitHub API failed" });
        }
        if (!found) throw new ORPCError("NOT_FOUND");
        return found;
      }),
  },

  system: adminProcedure
    .output(type<SystemInfo & { uptimeSeconds: number }>())
    .handler(({ context }) => {
      const system = context.system();
      return { ...system, uptimeSeconds: Math.floor((Date.now() - Date.parse(system.startedAt)) / 1000) };
    }),

  settings: {
    get: adminProcedure.output(type<SettingsView>()).handler(({ context }) => currentView(context.settings)),
    update: adminProcedure
      .input(
        z.object({
          integrationId: z.enum(INTEGRATION_IDS),
          values: z.record(z.string(), z.unknown()).default({}),
          clear: z.array(z.string()).optional(),
        }),
      )
      .output(type<SettingsView>())
      .handler(({ input, context }) => {
        try {
          context.settings.store.apply(planUpdate(input.integrationId, input));
        } catch (err) {
          if (err instanceof SettingsInputError || err instanceof SecretsUnavailableError) {
            throw new ORPCError("BAD_REQUEST", { message: err.message });
          }
          throw err;
        }
        context.settings.reload();
        return currentView(context.settings);
      }),
    testConnection: adminProcedure
      .input(z.object({ integrationId: z.enum(INTEGRATION_IDS) }))
      .output(type<ConnectionTestResult>())
      .handler(({ input, context }) => context.settings.test(input.integrationId)),
  },

  posthog: {
    preview: adminProcedure.output(type<PosthogPreview>()).handler(({ context }) => context.posthog.preview()),
    runNow: adminProcedure.output(type<PosthogRunResult>()).handler(({ context }) => context.posthog.runNow()),
  },
};

const currentView = ({ store, env }: Context["settings"]): SettingsView =>
  describeSettings(store, env, resolveConfig(store, env));

export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
export type { PosthogPreview, PosthogRunResult } from "../context";
export type { ConnectionTestResult, FieldView, IntegrationView, SettingsView } from "@automation-server/settings";

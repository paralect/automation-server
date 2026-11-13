import type {
  ActivityStats,
  Page,
  RunRecord,
  StoredLog,
  StoredRun,
} from "@automation-server/core";
import {
  describeSettings,
  envFor,
  INTEGRATION_IDS,
  planUpdate,
  PROJECT_ID_PATTERN,
  ProjectInputError,
  REPO_PATTERN,
  resolveConfig,
  SecretsUnavailableError,
  SettingsInputError,
  type ConnectionTestResult,
  type Project,
  type SettingsView,
} from "@automation-server/settings";
import { ORPCError, type, type RouterClient } from "@orpc/server";
import { z } from "zod";

import { adminProcedure, o } from "../index";
import type { Context, PosthogPreview, PosthogRunResult, SystemInfo } from "../context";
import { ACTION_STATES, type ActionsRunList, type WorkflowJob, type WorkflowRun } from "../githubActions";
import { WorkflowInstallError, type InstallResult, type WorkflowCheck, type WorkflowStatus } from "../workflowInstaller";
import { WORKFLOW_TEMPLATES, type IntegrationLink } from "../workflowTemplates";

const level = z.enum(["info", "warn", "error"]);
const status = z.enum(["running", "succeeded", "failed", "duplicate"]);
const page = { before: z.number().int().optional(), limit: z.number().int().min(1).max(200).default(50) };
const text = z.string().trim().min(1).max(200).optional();
const repo = z.string().trim().regex(new RegExp(REPO_PATTERN), "Repository must be in owner/name form").max(200);
const project = z.string().regex(new RegExp(PROJECT_ID_PATTERN), "Unknown project");
const projectFields = { name: z.string().max(200), domain: z.string().max(300).nullable().optional() };

/** Every project-scoped procedure answers NOT_FOUND for a project that does not exist (or was just deleted). */
function inProject(context: Context, id: string): string {
  if (!context.settings.db.getProject(id)) throw new ORPCError("NOT_FOUND", { message: `Project ${id} does not exist` });
  return id;
}

function projectCall<T>(run: () => T): T {
  try {
    return run();
  } catch (err) {
    if (err instanceof ProjectInputError) throw new ORPCError("BAD_REQUEST", { message: err.message });
    throw err;
  }
}

export type WorkflowTemplateInfo = {
  id: string;
  title: string;
  description: string;
  path: string;
  files: string[];
  requiredSecrets: string[][];
  requiredVariables: string[];
  integration: IntegrationLink | null;
};

const WORKFLOW_ERROR_CODE = { "not-configured": "PRECONDITION_FAILED", "unknown-template": "NOT_FOUND", github: "BAD_GATEWAY" } as const;

async function workflowCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof WorkflowInstallError) throw new ORPCError(WORKFLOW_ERROR_CODE[err.kind], { message: err.message });
    throw err;
  }
}

export const appRouter = {
  healthCheck: o.handler(() => "OK"),

  projects: {
    list: adminProcedure.output(type<Project[]>()).handler(({ context }) => context.settings.db.projects()),
    create: adminProcedure
      .input(z.object(projectFields))
      .output(type<Project>())
      .handler(({ input, context }) => {
        const created = projectCall(() => context.settings.db.createProject(input));
        context.settings.reload();
        return created;
      }),
    update: adminProcedure
      .input(z.object({ id: project, ...projectFields, name: projectFields.name.optional() }))
      .output(type<Project>())
      .handler(({ input: { id, ...changes }, context }) => {
        const updated = projectCall(() => context.settings.db.updateProject(id, changes));
        if (!updated) throw new ORPCError("NOT_FOUND", { message: `Project ${id} does not exist` });
        return updated;
      }),
    delete: adminProcedure
      .input(z.object({ id: project }))
      .output(type<{ deleted: boolean }>())
      .handler(({ input, context }) => {
        const deleted = projectCall(() => context.settings.db.deleteProject(input.id));
        if (!deleted) throw new ORPCError("NOT_FOUND", { message: `Project ${input.id} does not exist` });
        context.settings.reload();
        return { deleted };
      }),
  },

  overview: adminProcedure
    .input(z.object({ project, windowHours: z.number().int().min(1).max(168).default(24) }))
    .output(type<ActivityStats>())
    .handler(({ input, context }) => {
      const windowMs = input.windowHours * 3_600_000;
      const bucketMs = input.windowHours <= 24 ? 3_600_000 : 6 * 3_600_000;
      return context.activity.stats(new Date(Date.now() - windowMs).toISOString(), bucketMs, inProject(context, input.project));
    }),

  logs: {
    list: adminProcedure
      .input(z.object({ project, level: level.optional(), source: text, automation: text, runId: text, search: text, ...page }))
      .output(type<Page<StoredLog>>())
      .handler(({ input, context }) => context.activity.queryLogs({ ...input, project: inProject(context, input.project) })),
  },

  runs: {
    list: adminProcedure
      .input(z.object({ project, status: status.optional(), automation: text, source: text, search: text, ...page }))
      .output(type<Page<StoredRun>>())
      .handler(({ input, context }) => context.activity.queryRuns({ ...input, project: inProject(context, input.project) })),
    get: adminProcedure
      .input(z.object({ project, id: z.string().min(1) }))
      .output(type<{ run: RunRecord; logs: StoredLog[] }>())
      .handler(({ input, context }) => {
        const found = context.activity.getRun(input.id);
        if (!found || found.run.project !== inProject(context, input.project)) throw new ORPCError("NOT_FOUND");
        return found;
      }),
  },

  actions: {
    list: adminProcedure
      .input(
        z.object({
          project,
          repo: text,
          workflow: text,
          state: z.enum(ACTION_STATES).optional(),
          page: z.number().int().min(1).max(50).default(1),
        }),
      )
      .output(type<ActionsRunList>())
      .handler(({ input: { project, ...query }, context }) => context.actions(inProject(context, project)).listRuns(query)),
    get: adminProcedure
      .input(z.object({ project, repo: z.string().min(3).max(200), id: z.number().int().positive() }))
      .output(type<{ run: WorkflowRun; jobs: WorkflowJob[] }>())
      .handler(async ({ input, context }) => {
        const reader = context.actions(inProject(context, input.project));
        let found: Awaited<ReturnType<typeof reader.getRun>>;
        try {
          found = await reader.getRun(input.repo, input.id);
        } catch (err) {
          throw new ORPCError("BAD_GATEWAY", { message: err instanceof Error ? err.message : "GitHub API failed" });
        }
        if (!found) throw new ORPCError("NOT_FOUND");
        return found;
      }),
  },

  workflows: {
    templates: adminProcedure.output(type<WorkflowTemplateInfo[]>()).handler(() =>
      WORKFLOW_TEMPLATES.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        path: t.path,
        files: t.files.map((f) => f.path),
        requiredSecrets: t.requiredSecrets.map((names) => [...names]),
        requiredVariables: [...t.requiredVariables],
        integration: t.integration ?? null,
      })),
    ),
    status: adminProcedure
      .input(z.object({ project, repo }))
      .output(type<WorkflowStatus>())
      .handler(({ input, context }) => workflowCall(() => context.workflows(inProject(context, input.project)).status(input.repo))),
    check: adminProcedure
      .input(z.object({ project, repo, templateId: z.string().min(1).max(100) }))
      .output(type<WorkflowCheck>())
      .handler(({ input, context }) =>
        workflowCall(() => context.workflows(inProject(context, input.project)).check(input.repo, input.templateId)),
      ),
    install: adminProcedure
      .input(z.object({ project, repo, templateId: z.string().min(1).max(100), mode: z.enum(["pr", "direct"]).default("pr") }))
      .output(type<InstallResult>())
      .handler(({ input: { project, ...install }, context }) =>
        workflowCall(() => context.workflows(inProject(context, project)).install(install)),
      ),
  },

  system: adminProcedure
    .input(z.object({ project }))
    .output(type<SystemInfo & { uptimeSeconds: number }>())
    .handler(({ input, context }) => {
      const system = context.system(inProject(context, input.project));
      return { ...system, uptimeSeconds: Math.floor((Date.now() - Date.parse(system.startedAt)) / 1000) };
    }),

  settings: {
    get: adminProcedure
      .input(z.object({ project }))
      .output(type<SettingsView>())
      .handler(({ input, context }) => currentView(context.settings, inProject(context, input.project))),
    update: adminProcedure
      .input(
        z.object({
          project,
          integrationId: z.enum(INTEGRATION_IDS),
          values: z.record(z.string(), z.unknown()).default({}),
          clear: z.array(z.string()).optional(),
        }),
      )
      .output(type<SettingsView>())
      .handler(({ input, context }) => {
        const id = inProject(context, input.project);
        try {
          context.settings.db.project(id).apply(planUpdate(input.integrationId, input));
        } catch (err) {
          if (err instanceof SettingsInputError || err instanceof SecretsUnavailableError) {
            throw new ORPCError("BAD_REQUEST", { message: err.message });
          }
          throw err;
        }
        context.settings.reload();
        return currentView(context.settings, id);
      }),
    testConnection: adminProcedure
      .input(z.object({ project, integrationId: z.enum(INTEGRATION_IDS) }))
      .output(type<ConnectionTestResult>())
      .handler(({ input, context }) => context.settings.test(inProject(context, input.project), input.integrationId)),
  },

  posthog: {
    preview: adminProcedure
      .input(z.object({ project }))
      .output(type<PosthogPreview>())
      .handler(({ input, context }) => context.posthog.preview(inProject(context, input.project))),
    runNow: adminProcedure
      .input(z.object({ project }))
      .output(type<PosthogRunResult>())
      .handler(({ input, context }) => context.posthog.runNow(inProject(context, input.project))),
  },
};

const currentView = ({ db, env }: Context["settings"], project: string): SettingsView => {
  const store = db.project(project);
  const scopedEnv = envFor(project, env);
  return describeSettings(store, scopedEnv, resolveConfig(store, scopedEnv));
};

export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
export type { PosthogPreview, PosthogRunResult } from "../context";
export type { ConnectionTestResult, FieldView, IntegrationView, Project, SettingsView } from "@automation-server/settings";
export type {
  InstallMode,
  InstallOutcome,
  InstallResult,
  PullRequestRef,
  TemplateState,
  TemplateStatus,
  WorkflowCheck,
  WorkflowStatus,
} from "../workflowInstaller";
export type { IntegrationLink } from "../workflowTemplates";

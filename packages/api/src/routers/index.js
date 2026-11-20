import { ClaimStoreError, } from "@automation-server/core";
import { describeSettings, envFor, INTEGRATION_IDS, planUpdate, PROJECT_ID_PATTERN, ProjectInputError, REPO_PATTERN, resolveConfig, SecretsUnavailableError, SettingsInputError, } from "@automation-server/settings";
import { CRISP_DECISIONS, crispOutcomeSchema } from "@automation-server/sources/crisp/outcome";
import { ORPCError, type } from "@orpc/server";
import { z } from "zod";
import { adminProcedure, o } from "../index";
import { canReplay, SCHEDULE_SOURCE } from "../replay";
import { ACTION_STATES } from "../githubActions";
import { DAY_MS, HOUR_MS } from "../time";
import { SlackDirectoryError } from "../slackDirectory";
import { WorkflowInstallError } from "../workflowInstaller";
import { WORKFLOW_TEMPLATES } from "../workflowTemplates";
const CRISP_TRIAGE = "crisp-triage";
const toCrispItem = (run) => {
    const parsed = crispOutcomeSchema.safeParse(run.outcome);
    return {
        id: run.id,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        status: run.status,
        error: run.error,
        sessionId: parsed.success ? parsed.data.sessionId : run.externalId.replace(/:(triage|resolved)$/, ""),
        outcome: parsed.success ? parsed.data : null,
        read: Boolean(run.readAt),
    };
};
const level = z.enum(["info", "warn", "error"]);
const status = z.enum(["running", "succeeded", "failed", "duplicate"]);
const page = { before: z.number().int().optional(), limit: z.number().int().min(1).max(200).default(50) };
const text = z.string().trim().min(1).max(200).optional();
const repo = z.string().trim().regex(new RegExp(REPO_PATTERN), "Repository must be in owner/name form").max(200);
const project = z.string().regex(new RegExp(PROJECT_ID_PATTERN), "Unknown project");
const projectFields = { name: z.string().max(200), domain: z.string().max(300).nullable().optional() };
function inProject(context, id) {
    if (!context.settings.db.getProject(id))
        throw new ORPCError("NOT_FOUND", { message: `Project ${id} does not exist` });
    return id;
}
function runInProject(context, project, id) {
    const found = context.activity.getRun(id);
    if (!found || found.run.project !== inProject(context, project))
        throw new ORPCError("NOT_FOUND");
    return found;
}
const precondition = (message) => new ORPCError("PRECONDITION_FAILED", { message });
async function replayEvent(context, project, run, event, dryRun) {
    if (!event)
        throw precondition("This run has no stored event");
    let result;
    try {
        result = await context.replay.event({ project, automation: run.automation, event, replayOf: run.id, dryRun });
    }
    catch (err) {
        if (err instanceof ClaimStoreError)
            throw new ORPCError("BAD_GATEWAY", { message: "The claim store is unavailable, so the replay was not started. Try again in a moment." });
        throw err;
    }
    if (result.outcome === "unknown-automation")
        throw precondition(`${run.automation} is no longer configured for this project`);
    if (result.outcome === "duplicate")
        throw precondition("This event already ran successfully");
    return result.runId;
}
async function replayJob(context, project, run) {
    const result = await context.replay.job(project, run.automation, `replay:${new Date().toISOString()}`, run.id);
    if (result.status === "started")
        return result.runId;
    throw precondition(result.status === "busy" ? `${run.automation} is already running` : `${run.automation} is no longer configured for this project`);
}
function projectCall(run) {
    try {
        return run();
    }
    catch (err) {
        if (err instanceof ProjectInputError)
            throw new ORPCError("BAD_REQUEST", { message: err.message });
        throw err;
    }
}
const WORKFLOW_ERROR_CODE = { "not-configured": "PRECONDITION_FAILED", "unknown-template": "NOT_FOUND", github: "BAD_GATEWAY" };
async function workflowCall(run) {
    try {
        return await run();
    }
    catch (err) {
        if (err instanceof WorkflowInstallError)
            throw new ORPCError(WORKFLOW_ERROR_CODE[err.kind], { message: err.message });
        throw err;
    }
}
const DIRECTORY_ERROR_CODE = {
    "no-token": "PRECONDITION_FAILED",
    "missing-scope": "BAD_GATEWAY",
    rejected: "BAD_GATEWAY",
    failed: "BAD_GATEWAY",
};
async function directoryCall(run) {
    try {
        return await run();
    }
    catch (err) {
        if (err instanceof SlackDirectoryError)
            throw new ORPCError(DIRECTORY_ERROR_CODE[err.kind], { message: err.message });
        throw err;
    }
}
export const appRouter = {
    healthCheck: o.handler(() => "OK"),
    projects: {
        list: adminProcedure.output(type()).handler(({ context }) => context.settings.db.projects()),
        create: adminProcedure
            .input(z.object(projectFields))
            .output(type())
            .handler(({ input, context }) => {
            const created = projectCall(() => context.settings.db.createProject(input));
            context.settings.reload();
            return created;
        }),
        update: adminProcedure
            .input(z.object({ id: project, ...projectFields, name: projectFields.name.optional() }))
            .output(type())
            .handler(({ input: { id, ...changes }, context }) => {
            const updated = projectCall(() => context.settings.db.updateProject(id, changes));
            if (!updated)
                throw new ORPCError("NOT_FOUND", { message: `Project ${id} does not exist` });
            return updated;
        }),
        delete: adminProcedure
            .input(z.object({ id: project }))
            .output(type())
            .handler(({ input, context }) => {
            const deleted = projectCall(() => context.settings.db.deleteProject(input.id));
            if (!deleted)
                throw new ORPCError("NOT_FOUND", { message: `Project ${input.id} does not exist` });
            context.settings.reload();
            return { deleted };
        }),
    },
    overview: adminProcedure
        .input(z.object({ project, windowHours: z.number().int().min(1).max(168).default(24) }))
        .output(type())
        .handler(({ input, context }) => {
        const windowMs = input.windowHours * HOUR_MS;
        const bucketMs = input.windowHours <= 24 ? HOUR_MS : 6 * HOUR_MS;
        return context.activity.stats(new Date(Date.now() - windowMs).toISOString(), bucketMs, inProject(context, input.project));
    }),
    logs: {
        list: adminProcedure
            .input(z.object({ project, level: level.optional(), source: text, automation: text, runId: text, search: text, ...page }))
            .output(type())
            .handler(({ input, context }) => context.activity.queryLogs({ ...input, project: inProject(context, input.project) })),
    },
    runs: {
        list: adminProcedure
            .input(z.object({ project, status: status.optional(), automation: text, source: text, search: text, dryRun: z.enum(["include", "exclude", "only"]).optional(), ...page }))
            .output(type())
            .handler(({ input, context }) => context.activity.queryRuns({ ...input, project: inProject(context, input.project) })),
        get: adminProcedure
            .input(z.object({ project, id: z.string().min(1) }))
            .output(type())
            .handler(({ input, context }) => runInProject(context, input.project, input.id)),
        replay: adminProcedure
            .input(z.object({ project, id: z.string().min(1), dryRun: z.boolean().optional() }))
            .output(type())
            .handler(async ({ input, context }) => {
            const { run, event } = runInProject(context, input.project, input.id);
            const dryRun = input.dryRun === true;
            const check = canReplay(run, { dryRun });
            if (!check.ok)
                throw new ORPCError("PRECONDITION_FAILED", { message: check.reason });
            const started = run.source === SCHEDULE_SOURCE ? await replayJob(context, input.project, run) : await replayEvent(context, input.project, run, event, dryRun);
            if (!started)
                throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "The replay started but its run could not be recorded" });
            return { runId: started, status: "started" };
        }),
    },
    crisp: {
        list: adminProcedure
            .input(z.object({ project, decision: z.enum(CRISP_DECISIONS).optional(), unread: z.boolean().optional(), search: text, ...page }))
            .output(type())
            .handler(({ input, context }) => {
            const found = context.activity.queryRuns({
                project: inProject(context, input.project),
                automation: CRISP_TRIAGE,
                dryRun: "exclude",
                decision: input.decision,
                unread: input.unread,
                search: input.search,
                before: input.before,
                limit: input.limit,
            });
            return {
                // Left out: a repeated trigger (a duplicate run with no decision of its own) and runs that finished before
                // outcomes were recorded. Neither tells the team anything here, and both stay in Runs.
                items: found.items.filter((run) => run.status !== "duplicate" && (run.outcome || run.status !== "succeeded")).map(toCrispItem),
                nextCursor: found.nextCursor,
            };
        }),
        stats: adminProcedure
            .input(z.object({ project, windowDays: z.number().int().min(1).max(90).default(30) }))
            .output(type())
            .handler(({ input, context }) => {
            const since = new Date(Date.now() - input.windowDays * DAY_MS).toISOString();
            const projectId = inProject(context, input.project);
            const counts = context.activity.decisionCounts({ project: projectId, automation: CRISP_TRIAGE, sinceIso: since });
            const byDecision = Object.fromEntries(CRISP_DECISIONS.map((d) => [d, counts[d] ?? 0]));
            return {
                windowDays: input.windowDays,
                byDecision,
                withoutDecision: counts.none ?? 0,
                total: Object.values(counts).reduce((a, b) => a + b, 0),
                unread: context.activity.unreadCount({ project: projectId, automation: CRISP_TRIAGE }),
            };
        }),
        markRead: adminProcedure
            .input(z.object({ project, id: z.string().min(1), read: z.boolean() }))
            .output(type())
            .handler(({ input, context }) => {
            if (runInProject(context, input.project, input.id).run.automation !== CRISP_TRIAGE)
                throw new ORPCError("NOT_FOUND");
            context.activity.setRunRead(input.id, input.read ? new Date().toISOString() : null);
            return { read: input.read };
        }),
        markAllRead: adminProcedure
            .input(z.object({ project }))
            .output(type())
            .handler(({ input, context }) => ({
            changed: context.activity.markRunsRead({ project: inProject(context, input.project), automation: CRISP_TRIAGE, readAt: new Date().toISOString() }),
        })),
    },
    actions: {
        list: adminProcedure
            .input(z.object({
            project,
            repo: text,
            workflow: text,
            state: z.enum(ACTION_STATES).optional(),
            page: z.number().int().min(1).max(50).default(1),
        }))
            .output(type())
            .handler(({ input: { project, ...query }, context }) => context.actions(inProject(context, project)).listRuns(query)),
        get: adminProcedure
            .input(z.object({ project, repo: z.string().min(3).max(200), id: z.number().int().positive() }))
            .output(type())
            .handler(async ({ input, context }) => {
            const reader = context.actions(inProject(context, input.project));
            const found = await reader.getRun(input.repo, input.id).catch((err) => {
                throw new ORPCError("BAD_GATEWAY", { message: err instanceof Error ? err.message : "GitHub API failed" });
            });
            if (!found)
                throw new ORPCError("NOT_FOUND");
            return found;
        }),
    },
    workflows: {
        templates: adminProcedure.output(type()).handler(() => WORKFLOW_TEMPLATES.map((t) => ({
            id: t.id,
            title: t.title,
            description: t.description,
            path: t.path,
            files: t.files.map((f) => f.path),
            requiredSecrets: t.requiredSecrets.map((names) => [...names]),
            requiredVariables: [...t.requiredVariables],
            integration: t.integration ?? null,
        }))),
        status: adminProcedure
            .input(z.object({ project, repo }))
            .output(type())
            .handler(({ input, context }) => workflowCall(() => context.workflows(inProject(context, input.project)).status(input.repo))),
        check: adminProcedure
            .input(z.object({ project, repo, templateId: z.string().min(1).max(100) }))
            .output(type())
            .handler(({ input, context }) => workflowCall(() => context.workflows(inProject(context, input.project)).check(input.repo, input.templateId))),
        install: adminProcedure
            .input(z.object({ project, repo, templateId: z.string().min(1).max(100), mode: z.enum(["pr", "direct"]).default("pr") }))
            .output(type())
            .handler(({ input: { project, ...install }, context }) => workflowCall(() => context.workflows(inProject(context, project)).install(install))),
    },
    system: adminProcedure
        .input(z.object({ project }))
        .output(type())
        .handler(({ input, context }) => {
        const system = context.system(inProject(context, input.project));
        return { ...system, uptimeSeconds: Math.floor((Date.now() - Date.parse(system.startedAt)) / 1000) };
    }),
    settings: {
        get: adminProcedure
            .input(z.object({ project }))
            .output(type())
            .handler(({ input, context }) => currentView(context.settings, inProject(context, input.project))),
        update: adminProcedure
            .input(z.object({
            project,
            integrationId: z.enum(INTEGRATION_IDS),
            values: z.record(z.string(), z.unknown()).default({}),
            clear: z.array(z.string()).optional(),
        }))
            .output(type())
            .handler(({ input, context }) => {
            const id = inProject(context, input.project);
            try {
                context.settings.db.project(id).apply(planUpdate(input.integrationId, input));
            }
            catch (err) {
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
            .output(type())
            .handler(({ input, context }) => context.settings.test(inProject(context, input.project), input.integrationId)),
    },
    slack: {
        directory: adminProcedure
            .input(z.object({ project, kind: z.enum(["users", "channels"]), search: z.string().trim().max(100).optional(), refresh: z.boolean().optional() }))
            .output(type())
            .handler(({ input, context }) => directoryCall(() => context.slackDirectory.list({ ...input, project: inProject(context, input.project) }))),
    },
    posthog: {
        preview: adminProcedure
            .input(z.object({ project }))
            .output(type())
            .handler(({ input, context }) => context.posthog.preview(inProject(context, input.project))),
        runNow: adminProcedure
            .input(z.object({ project }))
            .output(type())
            .handler(({ input, context }) => context.posthog.runNow(inProject(context, input.project))),
    },
};
const currentView = ({ db, env, health }, project) => {
    const store = db.project(project);
    const scopedEnv = envFor(project, env);
    return describeSettings(store, scopedEnv, resolveConfig(store, scopedEnv), health(project));
};

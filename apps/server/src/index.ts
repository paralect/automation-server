import { errorMessage } from "@automation-server/api/errors";
import { createGithubActionsReader, type ActionsReader } from "@automation-server/api/githubActions";
import { DAY_MS, HOUR_MS } from "@automation-server/api/time";
import { createWorkflowInstaller } from "@automation-server/api/workflowInstaller";
import {
  createDispatcher,
  createLogger,
  createScheduler,
  createSqliteActivityStore,
  createSqlitePendingActionStore,
  createSqliteStore,
} from "@automation-server/core";
import {
  createSqliteHealthStore,
  createSqliteSettingsStore,
  DEFAULT_PROJECT_ID,
  effectiveActionsRepos,
  envFor,
  INTEGRATIONS,
  resolveConfig,
} from "@automation-server/settings";

import { createAlertNotifier } from "./alerts";
import { createApp } from "./app";
import { buildConfig, webhookUrls } from "./config";
import { ENV } from "./env.server";
import { createPosthogAdmin } from "./integrations/posthog";
import { INTEGRATION_MODULES } from "./integrations/registry";
import { createReplayAdmin } from "./replay";
import { createHealthSink } from "./health";
import { createRuntime } from "./runtime";

const config = buildConfig(ENV);

const store = createSqliteStore({ path: config.databasePath });
const activity = createSqliteActivityStore({ path: config.databasePath, legacyProject: DEFAULT_PROJECT_ID });
const pending = createSqlitePendingActionStore({ path: config.databasePath });
const settings = createSqliteSettingsStore({ path: config.databasePath, encryptionKey: config.encryptionKey });
const startedAt = new Date().toISOString();

const log = createLogger({}, console.log, (entry) => {
  try {
    activity.recordLog(entry);
  } catch (err) {
    console.error("activity recordLog failed", errorMessage(err));
  }
});

activity.failInterruptedRuns(startedAt);

const pruneOld = () => {
  try {
    activity.prune(new Date(Date.now() - config.retentionDays * DAY_MS).toISOString());
  } catch (err) {
    log.error("activity prune failed", { error: errorMessage(err) });
  }
  try {
    pending.prune(new Date(Date.now() - config.retentionDays * DAY_MS).toISOString());
  } catch (err) {
    log.error("pending action prune failed", { error: errorMessage(err) });
  }
};
pruneOld();
const pruneTimer = setInterval(pruneOld, HOUR_MS);
pruneTimer.unref();

const resolve = (project: string) => resolveConfig(settings.project(project), envFor(project, process.env));
const healthStore = createSqliteHealthStore({ path: config.databasePath });
const { onRunFinished, notifyHealth } = createAlertNotifier({ resolve, activity, log, adminUrl: config.adminPublicUrl, health: healthStore });
const runtime = createRuntime({
  modules: INTEGRATION_MODULES,
  projects: () => settings.projects().map((p) => p.id),
  resolve,
  deps: { log, pending },
  health: createHealthSink({ store: healthStore, notify: notifyHealth }),
});

const dispatcher = createDispatcher({
  automations: runtime.automations,
  store,
  log,
  activity,
  onRunFinished,
  prepare: (event) => runtime.source(event.project ?? DEFAULT_PROJECT_ID, event.source)?.enrich?.(event) ?? Promise.resolve(event),
});

const scheduler = createScheduler({ jobs: runtime.jobs, store, log, activity, onRunFinished });

// One reader per project, kept while its token and repositories stay the same so its cache survives.
const actionsReaders = new Map<string, { key: string; reader: ActionsReader }>();
const actions = (project: string): ActionsReader => {
  const { github } = resolve(project);
  const repos = effectiveActionsRepos(github);
  const token = github.values.token ?? "";
  const key = JSON.stringify([token, repos]);
  const cached = actionsReaders.get(project);
  if (cached?.key === key) return cached.reader;
  const reader = createGithubActionsReader({ repos, token });
  actionsReaders.set(project, { key, reader });
  return reader;
};

const webhookSources = Object.values(INTEGRATIONS).flatMap((spec) => ("webhookSource" in spec ? [spec.webhookSource] : []));

const reload = () => {
  runtime.rebuild();
  const live = new Set(settings.projects().map((p) => p.id));
  for (const project of actionsReaders.keys()) if (!live.has(project)) actionsReaders.delete(project);
};

const app = createApp({
  source: runtime.source,
  defaultProject: DEFAULT_PROJECT_ID,
  dispatcher,
  log,
  corsOrigin: ENV.CORS_ORIGIN,
  admin: {
    activity,
    actions,
    workflows: (project) => createWorkflowInstaller({ token: resolve(project).github.values.token }),
    adminToken: config.adminToken,
    settings: { db: settings, env: process.env, reload, test: runtime.test, health: healthStore.get },
    posthog: createPosthogAdmin({ resolve, scheduler }),
    replay: createReplayAdmin({ dispatcher, scheduler, jobs: (project) => runtime.project(project).jobs }),
    system: (project) => {
      const built = runtime.project(project);
      return {
        startedAt,
        sources: Object.keys(built.sources),
        automations: built.automations.map((a) => a.name),
        jobs: built.jobs.map((j) => j.name),
        retentionDays: config.retentionDays,
        webhookUrls: webhookUrls(project, webhookSources, config.publicUrl),
      };
    },
  },
});
const server = Bun.serve({ port: config.port, fetch: app.fetch });
log.info("server started", {
  port: server.port,
  projects: settings.projects().map((p) => p.id),
  automations: runtime.automations().map((a) => `${a.project}/${a.name}`),
  jobs: runtime.jobs().map((j) => `${j.project}/${j.name}`),
});
scheduler.start();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down", { signal });
  let exitCode = 0;
  try {
    clearInterval(pruneTimer);
    scheduler.stop();
    await server.stop();
    await Promise.all([dispatcher.drain(10_000), scheduler.drain(10_000)]);
    store.close();
    healthStore.close();
    pending.close();
    settings.close();
    log.info("shutdown complete");
    activity.close();
  } catch (err) {
    exitCode = 1;
    console.error("shutdown failed", errorMessage(err));
  } finally {
    process.exit(exitCode);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

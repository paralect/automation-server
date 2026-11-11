import { createGithubActionsReader, type ActionsReader } from "@automation-server/api/githubActions";
import {
  createDispatcher,
  createLogger,
  createScheduler,
  createSqliteActivityStore,
  createSqliteStore,
} from "@automation-server/core";
import {
  createSqliteSettingsStore,
  effectiveActionsRepos,
  INTEGRATIONS,
  resolveConfig,
} from "@automation-server/settings";

import { createApp } from "./app";
import { buildConfig, webhookUrls } from "./config";
import { ENV } from "./env.server";
import { createPosthogAdmin } from "./integrations/posthog";
import { INTEGRATION_MODULES } from "./integrations/registry";
import { createRuntime } from "./runtime";

const config = buildConfig(ENV);

const store = createSqliteStore({ path: config.databasePath });
const activity = createSqliteActivityStore({ path: config.databasePath });
const settings = createSqliteSettingsStore({ path: config.databasePath, encryptionKey: config.encryptionKey });
const startedAt = new Date().toISOString();

const log = createLogger({}, console.log, (entry) => {
  try {
    activity.recordLog(entry);
  } catch (err) {
    console.error("activity recordLog failed", err instanceof Error ? err.message : String(err));
  }
});

activity.failInterruptedRuns(startedAt);

const pruneOld = () => {
  try {
    activity.prune(new Date(Date.now() - config.retentionDays * 86_400_000).toISOString());
  } catch (err) {
    log.error("activity prune failed", { error: err instanceof Error ? err.message : String(err) });
  }
};
pruneOld();
const pruneTimer = setInterval(pruneOld, 3_600_000);
pruneTimer.unref();

const resolve = () => resolveConfig(settings, process.env);
const runtime = createRuntime({ modules: INTEGRATION_MODULES, resolve, deps: { log } });

const dispatcher = createDispatcher({
  automations: runtime.automations,
  store,
  log,
  activity,
  prepare: (event) => runtime.sources()[event.source]?.enrich?.(event) ?? Promise.resolve(event),
});

const scheduler = createScheduler({ jobs: runtime.jobs, store, log, activity });

let actionsReader: { key: string; reader: ActionsReader } | undefined;
const actions = (): ActionsReader => {
  const { github } = resolve();
  const repos = effectiveActionsRepos(github);
  const token = github.values.token ?? "";
  const key = JSON.stringify([token, repos]);
  if (actionsReader?.key !== key) actionsReader = { key, reader: createGithubActionsReader({ repos, token }) };
  return actionsReader.reader;
};

const webhookSources = Object.values(INTEGRATIONS).flatMap((spec) => ("webhookSource" in spec ? [spec.webhookSource] : []));

const app = createApp({
  sources: runtime.sources,
  dispatcher,
  log,
  corsOrigin: ENV.CORS_ORIGIN,
  admin: {
    activity,
    actions,
    adminToken: config.adminToken,
    settings: { store: settings, env: process.env, reload: runtime.rebuild, test: runtime.test },
    posthog: createPosthogAdmin({ resolve, scheduler }),
    system: () => ({
      startedAt,
      sources: Object.keys(runtime.sources()),
      automations: runtime.automations().map((a) => a.name),
      jobs: runtime.jobs().map((j) => j.name),
      retentionDays: config.retentionDays,
      webhookUrls: webhookUrls(webhookSources, config.publicUrl),
    }),
  },
});
const server = Bun.serve({ port: config.port, fetch: app.fetch });
log.info("server started", {
  port: server.port,
  sources: Object.keys(runtime.sources()),
  automations: runtime.automations().map((a) => a.name),
  jobs: runtime.jobs().map((j) => j.name),
});
scheduler.start();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down", { signal });
  clearInterval(pruneTimer);
  scheduler.stop();
  await server.stop();
  await Promise.all([dispatcher.drain(10_000), scheduler.drain(10_000)]);
  store.close();
  settings.close();
  log.info("shutdown complete");
  activity.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

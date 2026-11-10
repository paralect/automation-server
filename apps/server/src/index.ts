import { createGithubActionsReader } from "@automation-server/api/githubActions";
import { createAutomations } from "@automation-server/automations";
import { createDispatcher, createLogger, createSqliteActivityStore, createSqliteStore } from "@automation-server/core";
import { createSentrySource } from "@automation-server/sources";

import { createApp } from "./app";
import { buildConfig } from "./config";
import { ENV } from "./env.server";

const config = buildConfig(ENV);

const store = createSqliteStore({ path: config.databasePath });
const activity = createSqliteActivityStore({ path: config.databasePath });
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

const sentry = createSentrySource({
  clientSecret: config.sentry.clientSecret,
  apiBaseUrl: config.sentry.apiBaseUrl,
  authToken: config.sentry.authToken,
});
const sources = { [sentry.name]: sentry };

const automations = createAutomations({
  sentryToGithubIssue: {
    repo: config.github.repo,
    token: config.github.token,
    levels: config.filters.levels,
    environments: config.filters.environments,
    minEventCount: config.filters.minEventCount,
  },
});

const dispatcher = createDispatcher({
  automations,
  store,
  log,
  activity,
  prepare: (event) => sources[event.source]?.enrich?.(event) ?? Promise.resolve(event),
});

const app = createApp({
  sources,
  dispatcher,
  log,
  corsOrigin: ENV.CORS_ORIGIN,
  admin: {
    activity,
    actions: createGithubActionsReader({ repos: config.github.actionsRepos, token: config.github.token }),
    adminToken: config.adminToken,
    system: {
      startedAt,
      sources: Object.keys(sources),
      automations: automations.map((a) => a.name),
      retentionDays: config.retentionDays,
    },
  },
});
const server = Bun.serve({ port: config.port, fetch: app.fetch });
log.info("server started", { port: server.port, repo: `${config.github.repo.owner}/${config.github.repo.name}` });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down", { signal });
  clearInterval(pruneTimer);
  await server.stop();
  await dispatcher.drain(10_000);
  store.close();
  log.info("shutdown complete");
  activity.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

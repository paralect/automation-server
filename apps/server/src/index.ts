import { createAutomations } from "@automation-server/automations";
import { createDispatcher, createLogger, createSqliteStore } from "@automation-server/core";
import { createSentrySource } from "@automation-server/sources";

import { createApp } from "./app";
import { buildConfig } from "./config";
import { ENV } from "./env.server";

const config = buildConfig(ENV);
const log = createLogger();

const store = createSqliteStore({ path: config.databasePath });

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
  prepare: (event) => sources[event.source]?.enrich?.(event) ?? Promise.resolve(event),
});

const app = createApp({ sources, dispatcher, log, corsOrigin: ENV.CORS_ORIGIN });
const server = Bun.serve({ port: config.port, fetch: app.fetch });
log.info("server started", { port: server.port, repo: `${config.github.repo.owner}/${config.github.repo.name}` });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down", { signal });
  await server.stop();
  await dispatcher.drain(10_000);
  store.close();
  log.info("shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

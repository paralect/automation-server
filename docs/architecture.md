# Architecture

The server is a Hono app on Bun, split into workspaces so that adding an integration touches one folder and one registry line.

| Package | Responsibility |
| --- | --- |
| `packages/core` | Generic types and machinery: `Event`, `Source`, `Automation`, `Job`, the dispatcher, the scheduler, the sqlite claim store, the sqlite activity store and the logger. Knows nothing about any specific service. |
| `packages/sources` | One folder per service that sends webhooks. Verifies the signature, parses the payload into an `Event`, optionally enriches it. |
| `packages/settings` | Settings store (sqlite, AES-256-GCM secrets), the typed `INTEGRATIONS` spec registry and the resolver that produces each integration's effective config. No runtime dependencies on the rest. |
| `packages/automations` | One folder per automation. Matches events and does the work. `registry.ts` lists them. |
| `apps/server` | HTTP wiring: `POST /webhooks/:source`, config validation, startup, graceful shutdown, and the runtime that builds sources, automations and jobs from integration modules. |
| `packages/api` | oRPC routers, including the admin API over the activity store. |

## Request lifecycle

1. `POST /webhooks/:source` looks the source up by name (404 if unknown) and reads the body with a size cap (413 if exceeded).
2. `Source.verify` checks the signature over the raw bytes (401 on failure).
3. `Source.parse` produces an `Event { source, kind, externalId, payload }`.
4. The server logs `webhook received` and responds `200`. Everything after this runs in the background.
5. The dispatcher finds every automation whose `matches` accepts the event and claims `(automation, externalId)` in sqlite. An existing claim means a duplicate, which is skipped and recorded as a `duplicate` run.
6. A successful claim starts a run (`running`). Every log line of the automation carries its `runId`.
7. The automation runs. On success the run becomes `succeeded`. If it throws, the run becomes `failed` with the error message and the claim is released so a redelivery can retry.

## Activity store and admin API

Every log line is written to stdout and also recorded in the `logs` table. Every automation run, including duplicates, is a row in the `runs` table. Both tables live in the same sqlite file as the claims (`DATABASE_PATH`), each behind its own connection. `source`, `automation`, `externalId` and `runId` are lifted out of the log fields into indexed columns, and the full fields are kept as JSON.

- Runs still `running` at startup are marked `failed` with `interrupted by server restart`.
- Logs and finished runs older than `LOG_RETENTION_DAYS` are pruned at startup and every hour.
- Recording is best effort. A failing activity store is logged to stdout and never blocks dispatching.
- The admin API (`overview`, `logs.list`, `runs.list`, `runs.get`, `system`, `settings.get`, `settings.update`, `settings.testConnection`) is served by oRPC under `/rpc` and requires `Authorization: Bearer <ADMIN_API_TOKEN>`. It answers 401 to every request while `ADMIN_API_TOKEN` is unset.
- `actions.list` and `actions.get` read GitHub Actions workflow runs, with their jobs and steps, from the GitHub REST API using `GITHUB_TOKEN`. The repositories come from `GITHUB_ACTIONS_REPOS` (default `GITHUB_REPO`), and the token needs Actions: Read on each. Nothing is stored: GitHub stays the source of truth. Responses are cached for 4 seconds and the workflow list for 5 minutes, so several open admin tabs share one GitHub request. A repository the token cannot read is reported next to the runs of the others, not as a failure of the whole list. `actions.get` answers 404 for a repository outside the list.
- To fill the dashboard with sample data, start a local server and run `bun apps/server/scripts/demo-traffic.ts` with the same `SENTRY_CLIENT_SECRET` (optional `SERVER_URL`, default `http://localhost:3000`).

- `settings.get` returns every integration with its fields, the effective value of non-secret fields, where each value comes from and whether the integration is configured. `settings.update({ integrationId, values, clear? })` validates against the spec, stores a secret only for a non-empty string, removes the keys in `clear` and rebuilds the runtime. `settings.testConnection({ integrationId })` calls the module's `test` hook (implemented for `github`, answering `available: false` for the rest).
- `system` also returns the registered jobs and `webhookUrls`, built from the optional `PUBLIC_URL` (relative paths when it is unset).

The admin UI lives in `apps/admin`.

## Settings and integration modules

Integrations are configured through settings, not only environment variables.

- `INTEGRATIONS` in `packages/settings/src/spec.ts` is the domain model: one spec per integration (`github`, `sentry`, `linear`, `posthog`) listing its fields (`text`, `secret`, `number`, `boolean`, `select`, `list`). Validation, the admin form and the resolved types are all derived from it.
- The effective value of a field is the settings table value, else the legacy environment variable (the field's `env`), else the spec default. An empty environment variable counts as unset. Existing env-only deployments therefore behave as before.
- An integration whose required fields are all present is `configured`. An unconfigured integration is simply not registered, so the server boots with no integration env at all.
- Settings live in the `settings` table of the same sqlite file. Secret values are encrypted with AES-256-GCM using a key derived (HKDF-SHA256) from `SETTINGS_ENCRYPTION_KEY`. Without that variable, plain settings work and writing a secret is rejected. Secrets are write-only: the API reports only whether one is set, and from where (`db`, `env`, `default`, `unset`). A secret that cannot be decrypted (key changed) is treated as unset.
- `apps/server/src/integrations/registry.ts` lists the `IntegrationModule`s. A module's `build(resolvedConfig, deps)` returns the `sources`, `automations` and `jobs` it contributes, and its optional `test` hook backs `settings.testConnection`. Modules for unconfigured integrations are skipped, and a module that throws is logged and skipped.
- The runtime holder builds all modules at boot and again after every `settings.update`, then swaps one immutable snapshot. The dispatcher, the webhook routes and the admin API read through getters, so a saved setting applies to the next event or request without a restart. Runs already in flight finish on the snapshot they started with.

## Scheduler

`Job { name, due(now) => claimKey | null, run(ctx) }` in `packages/core`. The server ticks every 60 seconds. For each job whose `due` returns a key, the scheduler claims `(job name, key)` in the claim store, so an occurrence runs at most once, also across restarts. A run is recorded in the activity store with source `schedule`, so it shows on the Runs and Logs pages like an automation run. A failed occurrence is recorded as failed and not retried by the ticker, to avoid one failing call per minute. `Scheduler.runNow(jobOrName, key)` runs a job under an explicit key (for example `manual:<timestamp>`) through the same recording. It also accepts a job object that is not on the schedule, so the admin can run a disabled job. Shutdown stops the ticker and drains running jobs.

## Principles

- Verify before parsing, parse before dispatching.
- Respond to the sender fast; do slow work in the background and drain it on shutdown.
- Secrets and raw payloads are never logged.
- Core stays service-agnostic. Service-specific code lives in `sources/<service>` and `automations/<name>`.

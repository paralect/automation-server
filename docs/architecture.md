# Architecture

The server is a Hono app on Bun, split into workspaces so that adding an integration touches one folder and one registry line.

| Package | Responsibility |
| --- | --- |
| `packages/core` | Generic types and machinery: `Event`, `Source`, `Automation`, the dispatcher, the sqlite claim store, the sqlite activity store and the logger. Knows nothing about any specific service. |
| `packages/sources` | One folder per service that sends webhooks. Verifies the signature, parses the payload into an `Event`, optionally enriches it. |
| `packages/automations` | One folder per automation. Matches events and does the work. `registry.ts` lists them. |
| `apps/server` | HTTP wiring: `POST /webhooks/:source`, config validation, startup, graceful shutdown. |
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
- The admin API (`overview`, `logs.list`, `runs.list`, `runs.get`, `system`) is served by oRPC under `/rpc` and requires `Authorization: Bearer <ADMIN_API_TOKEN>`. It answers 401 to every request while `ADMIN_API_TOKEN` is unset.
- To fill the dashboard with sample data, start a local server and run `bun apps/server/scripts/demo-traffic.ts` with the same `SENTRY_CLIENT_SECRET` (optional `SERVER_URL`, default `http://localhost:3000`).

The admin UI lives in `apps/admin`.

## Principles

- Verify before parsing, parse before dispatching.
- Respond to the sender fast; do slow work in the background and drain it on shutdown.
- Secrets and raw payloads are never logged.
- Core stays service-agnostic. Service-specific code lives in `sources/<service>` and `automations/<name>`.

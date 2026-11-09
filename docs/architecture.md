# Architecture

The server is a Hono app on Bun, split into workspaces so that adding an integration touches one folder and one registry line.

| Package | Responsibility |
| --- | --- |
| `packages/core` | Generic types and machinery: `Event`, `Source`, `Automation`, the dispatcher, the sqlite claim store and the logger. Knows nothing about any specific service. |
| `packages/sources` | One folder per service that sends webhooks. Verifies the signature, parses the payload into an `Event`, optionally enriches it. |
| `packages/automations` | One folder per automation. Matches events and does the work. `registry.ts` lists them. |
| `apps/server` | HTTP wiring: `POST /webhooks/:source`, config validation, startup, graceful shutdown. |
| `packages/api` | oRPC routers for browser-facing routes. |

## Request lifecycle

1. `POST /webhooks/:source` looks the source up by name (404 if unknown) and reads the body with a size cap (413 if exceeded).
2. `Source.verify` checks the signature over the raw bytes (401 on failure).
3. `Source.parse` produces an `Event { source, kind, externalId, payload }`.
4. The server responds `200`. Everything after this runs in the background.
5. The dispatcher finds every automation whose `matches` accepts the event and claims `(automation, externalId)` in sqlite. An existing claim means a duplicate, which is skipped.
6. The automation runs. If it throws, the claim is released so a redelivery can retry.

## Principles

- Verify before parsing, parse before dispatching.
- Respond to the sender fast; do slow work in the background and drain it on shutdown.
- Secrets and raw payloads are never logged.
- Core stays service-agnostic. Service-specific code lives in `sources/<service>` and `automations/<name>`.

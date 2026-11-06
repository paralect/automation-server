# automation-server

A small webhook server that turns events from external services into actions. Today it ships one flow: a Sentry issue alert becomes one GitHub issue, labelled so that a GitHub Action that watches issues labelled `sentry` can pick it up from there.

```
Sentry issue alert
      |
      v
POST /webhooks/sentry  --- verify HMAC-SHA256 over the raw body (401 on failure)
      |
      v
Source.parse  ----------- Event { source, kind, externalId, payload }
      |  (200 returned here, work continues in the background)
      v
Dispatcher  ------------- claim (automation, externalId) in sqlite; duplicates are skipped
      |
      v
Automation  ------------- filters (level, environment, event count) -> GitHub issue
```

Sentry expects a response within about one second, so the server answers `200` as soon as the signature checks out and the event is parsed. Enrichment and the GitHub calls run in the background and are drained on shutdown.

## Behavior

- **One GitHub issue per Sentry issue.** The issue body carries a `Sentry Issue: <id>` marker. Before creating, the automation looks through the repo's open issues labelled `sentry` for that marker. Deliveries are also deduplicated by a sqlite claim, so a redelivered alert is skipped. A failed run releases its claim, so a redelivery can retry.
- **Filters.** `SENTRY_LEVELS` (default `error,fatal`), `SENTRY_ENVIRONMENTS` (empty means all) and `SENTRY_MIN_EVENT_COUNT` (default `1`).
- **Event count needs a token.** The `event_alert` payload has no event count, first seen or last seen. Those come from the Sentry API, so set `SENTRY_AUTH_TOKEN` to enable them. Without it, the count filter is not applied and the issue omits those stats.
- **Redaction.** Issue content is scrubbed of common secret shapes before it is sent to GitHub. Payload bodies and secrets are never logged.

## Setup

### Sentry

1. In Sentry, open Settings, then Developer Settings, then create a new Internal Integration.
2. Set the Webhook URL to `https://<your-host>/webhooks/sentry`.
3. Enable the Alert Rule Action toggle so the integration can be used as an alert action.
4. Save, then copy the Client Secret from the integration page. This is `SENTRY_CLIENT_SECRET`.
5. Create or edit an Issue Alert and add the action "Send a notification via <integration name>".
6. Optional: from the same integration page, copy a token for `SENTRY_AUTH_TOKEN`. Give it read access to Issue & Event.

These steps follow Sentry's [integration platform docs](https://docs.sentry.io/organization/integrations/integration-platform/). The docs confirm Developer Settings, the Client Secret signature, per-integration tokens and the "Send a notification via <your integration>" action. The Alert Rule Action toggle and the exact scope label were not found in the public docs text, so check them against your Sentry UI.

### GitHub

Create a fine-grained personal access token at Settings, Developer settings, Personal access tokens.

- Repository access: only the one repository that should receive issues.
- Repository permissions: Issues set to Read and write. Metadata is read-only and implicit.

Use it as `GITHUB_TOKEN`, and set `GITHUB_REPO` to `owner/name`.

## Configuration

Configuration is validated at startup with [Varlock](https://varlock.dev). A missing or invalid required value stops the server and names the variable. The schema is `apps/server/.env.schema`. Put local values in `apps/server/.env.local` (see `apps/server/.env.example`). Run `bun run env:generate` after changing the schema.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `SENTRY_CLIENT_SECRET` | yes | | Client Secret of the Sentry integration. Verifies webhook signatures. |
| `GITHUB_TOKEN` | yes | | GitHub token with Issues: Read and write on the target repo. |
| `GITHUB_REPO` | yes | | Target repository as `owner/name`. |
| `PORT` | no | `3000` | HTTP port. |
| `DATABASE_PATH` | no | `./data/automation.db` | sqlite file for claims. Keep it on persistent storage. |
| `SENTRY_AUTH_TOKEN` | no | | Enables issue stats enrichment (count, first and last seen). |
| `SENTRY_API_BASE_URL` | no | `https://sentry.io` | Sentry host. The token is only sent to this origin. |
| `SENTRY_LEVELS` | no | `error,fatal` | Comma-separated levels that create an issue. |
| `SENTRY_ENVIRONMENTS` | no | empty (all) | Comma-separated environments to handle. |
| `SENTRY_MIN_EVENT_COUNT` | no | `1` | Minimum event count, applied only when the count is known. |
| `CORS_ORIGIN` | no | | Origin allowed on the browser-facing oRPC routes. Not used by webhooks. |

## Running

```bash
bun install
bun run dev        # watch mode on http://localhost:3000
bun run test
bun run check-types
bun run build      # apps/server/dist/index.mjs
bun run start      # run the built server (from apps/server)
```

`GET /health` returns `{"status":"ok"}`. On SIGTERM or SIGINT the server stops accepting connections, waits up to 10 seconds for in-flight work, closes the store and exits.

### Docker

```bash
docker build -t automation-server .
docker run -d --name automation-server -p 3000:3000 \
  -v automation-data:/data \
  -e SENTRY_CLIENT_SECRET=... \
  -e GITHUB_TOKEN=... \
  -e GITHUB_REPO=your-org/your-repo \
  automation-server
```

The image runs as a non-root user and stores the claim database at `/data/automation.db`. Mount a volume on `/data` so claims survive restarts.

## Adding an automation

Automations match events and run. The dispatcher handles claiming, retries on failure and logging.

```ts
// packages/automations/src/notifyOnFatal/automation.ts
import { defineAutomation } from "@automation-server/core/automation";
import { isSentryIssueAlert } from "@automation-server/sources/sentry/event";

export const notifyOnFatal = defineAutomation({
  name: "notify-on-fatal",
  matches: isSentryIssueAlert,
  async run(event, { log }) {
    if (event.payload.level !== "fatal") return;
    log.info("fatal alert", { issueId: event.payload.issueId });
  },
});
```

Then add one line to the list in `packages/automations/src/registry.ts`. Throwing from `run` releases the claim so the delivery can be retried.

## Project Structure

```
automation-server/
├── apps/
│   └── server/          # Hono app: webhook routes, config, wiring, Bun.serve entry
├── packages/
│   ├── core/            # Event, Source, Automation, dispatcher, sqlite claim store, logger
│   ├── sources/         # Sentry source: signature check, payload parsing, optional enrichment
│   ├── automations/     # Automations and the registry (sentry-to-github-issue)
│   ├── api/             # oRPC routers
│   └── config/          # Shared tsconfig
```

## License

MIT

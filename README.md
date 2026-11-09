# automation-server

A small, self-hosted webhook server that turns events from external services into actions.

Each integration plugs in at one of two points: a **source** receives and verifies webhooks from a service, and an **automation** reacts to the normalized events. Delivery, deduplication, retries and logging are handled once, in the core.

```
POST /webhooks/<source>  --- Source.verify (raw body, 401 on failure)
        |
        v
Source.parse  ------------- Event { source, kind, externalId, payload }
        |  (200 returned here, work continues in the background)
        v
Dispatcher  --------------- claim (automation, externalId) in sqlite; duplicates are skipped
        |
        v
Automation(s)  ------------ match the event, do the work, release the claim on failure
```

## Integrations

| Integration | Kind | What it does | Docs |
| --- | --- | --- | --- |
| Sentry | source | Verifies and parses Sentry issue alerts (`POST /webhooks/sentry`) | [docs/integrations/sentry.md](docs/integrations/sentry.md) |
| GitHub Issues | action | Creates one labelled GitHub issue per Sentry issue (`sentry-to-github-issue`) | [docs/integrations/sentry.md](docs/integrations/sentry.md) |

More are planned. See [docs/adding-an-integration.md](docs/adding-an-integration.md) to add your own.

## Quick start

Requires [Bun](https://bun.sh) 1.4+.

```bash
bun install
cp apps/server/.env.example apps/server/.env.local   # fill in the values
bun run dev                                          # http://localhost:3000
```

`GET /health` returns `{"status":"ok"}`. On SIGTERM or SIGINT the server stops accepting connections, waits up to 10 seconds for in-flight work, closes the store and exits.

### Docker

```bash
docker build -t automation-server .
docker run -d --name automation-server -p 3000:3000 \
  -v automation-data:/data \
  --env-file apps/server/.env.local \
  automation-server
```

The image runs as a non-root user and keeps its state in `/data/automation.db`. Mount a volume on `/data` so claims survive restarts.

## Configuration

Configuration is validated at startup with [Varlock](https://varlock.dev). A missing or invalid required value stops the server and names the variable. The schema lives in `apps/server/.env.schema`; put local values in `apps/server/.env.local` (see `apps/server/.env.example`). Run `bun run env:generate` after changing the schema.

Server-wide settings:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PORT` | no | `3000` | HTTP port. |
| `DATABASE_PATH` | no | `./data/automation.db` | sqlite file for claims. Keep it on persistent storage. |
| `CORS_ORIGIN` | no | | Origin allowed on the browser-facing oRPC routes. Not used by webhooks. |

Each integration documents its own variables in its page under [docs/integrations](docs/integrations).

## Development

```bash
bun run dev           # watch mode
bun run test          # all workspaces
bun run check-types
bun run build         # apps/server/dist/index.mjs
```

## Project structure

```
automation-server/
├── apps/
│   └── server/          # Hono app: webhook routes, config, wiring, Bun.serve entry
├── packages/
│   ├── core/            # Event, Source, Automation, dispatcher, sqlite claim store, logger
│   ├── sources/         # One folder per service that sends webhooks (sentry/)
│   ├── automations/     # One folder per automation, plus the registry
│   ├── api/             # oRPC routers
│   └── config/          # Shared tsconfig
├── docs/                # Architecture, integration guides
└── github-actions/      # Reusable GitHub Actions workflows (stored, not active)
```

## Documentation

- [Architecture](docs/architecture.md)
- [Adding an integration](docs/adding-an-integration.md)
- [Sentry integration](docs/integrations/sentry.md)
- [GitHub Actions library](github-actions/README.md)

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first. To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

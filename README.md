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

## Deployment

The server and the admin ship as one Docker image. Pick one of three setups, and for the first two choose where the image comes from:

| Setup | When | HTTPS | History survives restarts |
| --- | --- | --- | --- |
| Docker Compose | A machine that already has a reverse proxy | Your proxy | Yes |
| Docker Compose with Traefik | A plain VPS | Let's Encrypt, automatic | Yes |
| DigitalOcean App Platform | No server to manage | Managed | No, the disk is ephemeral |

| Image | How | Server needs |
| --- | --- | --- |
| Prebuilt | Pull `ghcr.io/<owner>/<repo>`, built by CI on every push to `main` (`linux/amd64` and `linux/arm64`) | 512 MB RAM, updates take seconds |
| Built on the server | `docker build` from the checkout | About 1 GB RAM, a few minutes per update |

### VPS in one command

On a fresh Ubuntu or Debian VPS, with two DNS A records pointing at it (one for webhooks, one for the admin):

```bash
curl -fsSL https://raw.githubusercontent.com/prlct/automation-server/main/scripts/deploy-vps.sh | sudo bash
```

The script installs Docker if it is missing, clones the repository to `/opt/automation-server`, asks whether to pull the prebuilt image or build on the server, asks for the GitHub and Sentry settings, generates the admin password and secrets into `.env` (mode 600), opens ports 80 and 443 in `ufw` if it is active, and starts everything behind Traefik. At the end it prints the admin URL, the admin password and the webhook URL to paste into Sentry.

Run it again to update: it pulls the new image (or rebuilds) and restarts, and keeps `.env`.

```bash
sudo /opt/automation-server/scripts/deploy-vps.sh
```

- Answer "no" to the Traefik question to publish the server on port 3000 and keep the admin on `127.0.0.1:3001`.
- Every question can be answered ahead with an environment variable of the same name, for unattended installs. Without a terminal and without `DEPLOY_MODE` the script builds on the server.
- `DEPLOY_MODE=image` or `DEPLOY_MODE=build` on any run switches an existing install between the two.
- `IMAGE_TAG=sha-<commit>` pins the prebuilt image to one build, which is also how you roll back. The default is `latest`.
- **While the repository is private** the one-liner needs a token, because `raw.githubusercontent.com` answers 404 without one, and so does `git clone`. Create a classic token with the `repo` and `read:packages` scopes at https://github.com/settings/tokens and run:

  ```bash
  export TOKEN=ghp_...
  curl -fsSL -H "Authorization: Bearer $TOKEN" https://raw.githubusercontent.com/prlct/automation-server/main/scripts/deploy-vps.sh \
    | sudo REPO_TOKEN="$TOKEN" GHCR_USER=<github-user> GHCR_TOKEN="$TOKEN" bash
  ```

  `REPO_TOKEN` clones and updates the repository, `GHCR_USER` and `GHCR_TOKEN` log in to the registry for the image. The script also asks for them on a terminal if you leave them out. The token is sent in a request header and is not stored in `.git/config`. `docker login` keeps the registry credentials in `~/.docker/config.json` of root, so later updates need no token for the image, but a repository update does, so keep `REPO_TOKEN` handy or run the update with it.
- A private repository publishes a private package, and the server must log in to pull it. Making the package public in its settings skips the login. A public package and a private repository can coexist, but the script still needs `REPO_TOKEN` to clone.

### Docker Compose by hand

```bash
cp .env.example .env    # fill in the secrets
docker compose up -d --build
```

To pull the prebuilt image instead, use `docker-compose.ghcr.yml`: `docker compose -f docker-compose.ghcr.yml pull && docker compose -f docker-compose.ghcr.yml up -d`, or set `COMPOSE_FILE` in `.env`. For Traefik, set the domains in `.env` and uncomment the `COMPOSE_FILE` line. For DigitalOcean, `doctl apps create --spec .do/app.yaml`. Details, routing and the App Platform storage caveat are in [docs/deployment.md](docs/deployment.md).

## Configuration

Configuration is validated at startup with [Varlock](https://varlock.dev). A missing or invalid required value stops the server and names the variable. The schema lives in `apps/server/.env.schema`; put local values in `apps/server/.env.local` (see `apps/server/.env.example`). Run `bun run env:generate` after changing the schema.

Server-wide settings:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PORT` | no | `3000` | HTTP port. |
| `DATABASE_PATH` | no | `./data/automation.db` | sqlite file for claims, run history and logs. Keep it on persistent storage. |
| `CORS_ORIGIN` | no | | Origin allowed on the browser-facing oRPC routes. Not used by webhooks. |
| `ADMIN_API_TOKEN` | no | | Bearer token for the admin API under `/rpc`. Use at least 32 random characters. The admin API is disabled when empty. |
| `LOG_RETENTION_DAYS` | no | `30` | Days to keep stored logs and finished runs. |
| `SETTINGS_ENCRYPTION_KEY` | no | | Encrypts secrets saved from the admin (AES-256-GCM). At least 32 random characters. Keep it stable: changing it makes saved secrets unreadable. Saving a secret is refused while it is unset. |
| `PUBLIC_URL` | no | | Public base URL of the server, used to show full webhook URLs in the admin. |
| `GITHUB_ACTIONS_REPOS` | no | `GITHUB_REPO` | Comma-separated `owner/name` repositories whose GitHub Actions runs the admin shows. `GITHUB_TOKEN` needs Actions: Read on each. |

`GITHUB_TOKEN`, `GITHUB_REPO` and `SENTRY_CLIENT_SECRET` are optional: each integration can be configured from the admin API instead, and an integration with missing required values is simply not registered. Each integration documents its own variables in its page under [docs/integrations](docs/integrations).

## Admin dashboard

`apps/admin` is a read-only dashboard for what the server did: webhooks received, automation runs, failures and logs. It also tracks GitHub Actions runs, such as the Codex workflows below, with live status, jobs and steps. It runs as its own app on port 3001 and needs `ADMIN_API_TOKEN` set on the server. Setup and the security model are in [apps/admin/README.md](apps/admin/README.md).

## GitHub Actions workflows

Ready-made GitHub Actions workflows live in [`github-actions/`](github-actions/README.md). They are stored there, not active in this repository. Copy the one you need into the `.github/workflows/` directory of the target repository.

| Workflow | What it does |
| --- | --- |
| [`codex-issue-fix.yml`](github-actions/codex-issue-fix.yml) | Opens a draft PR with a Codex-written fix for each new issue. Pairs with the Sentry integration: issues labelled `sentry` can trigger it. |
| [`codex-seo-autopilot.yml`](github-actions/codex-seo-autopilot.yml) | Runs the [seo-autopilot](https://il.ly/skills/seo-autopilot) skill with Codex every day and opens a PR with the changes. |
| [`codex-changelog.yml`](github-actions/codex-changelog.yml) | On every push to your production branch, Codex writes a changelog note from the pushed commits and opens a PR. |

Setup, secrets and caveats for each workflow are in [github-actions/README.md](github-actions/README.md).

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
│   ├── server/          # Hono app: webhook routes, config, wiring, Bun.serve entry
│   └── admin/           # TanStack Start admin dashboard (logs, runs, GitHub Actions, system)
├── packages/
│   ├── core/            # Event, Source, Automation, dispatcher, sqlite claim store, logger
│   ├── sources/         # One folder per service that sends webhooks (sentry/)
│   ├── automations/     # One folder per automation, plus the registry
│   ├── api/             # oRPC routers
│   └── config/          # Shared tsconfig
├── docs/                # Architecture, deployment, integration guides
├── scripts/             # deploy-vps.sh
├── .do/                 # DigitalOcean App Platform spec
├── github-actions/      # Reusable GitHub Actions workflows (stored, not active)
├── Dockerfile           # One image for the server and the admin
├── docker-compose.yml          # builds the image on the server
├── docker-compose.ghcr.yml     # pulls the image CI publishes
└── docker-compose.traefik.yml  # optional HTTPS overlay for either
```

## Documentation

- [Architecture](docs/architecture.md)
- [Deployment](docs/deployment.md)
- [Adding an integration](docs/adding-an-integration.md)
- [Sentry integration](docs/integrations/sentry.md)
- [GitHub Actions workflows](github-actions/README.md)

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first. To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

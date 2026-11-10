# Deployment

The server and the admin ship as one Docker image built from the root `Dockerfile`. The server is the default command. The admin runs from the same image with `bun run /app/apps/admin/serve.ts`.

| Option | HTTPS | Keeps history across restarts | Files |
| --- | --- | --- | --- |
| Docker Compose | No, put your own proxy in front | Yes, volume `data` | `docker-compose.yml` |
| Docker Compose with Traefik | Yes, Let's Encrypt | Yes | `docker-compose.yml` + `docker-compose.traefik.yml` |
| DigitalOcean App Platform | Yes, managed | No, see below | `.do/app.yaml` |

What has to be reachable from where:

- Sentry must reach `POST /webhooks/sentry` on the server. That is the only public route the server needs, plus `/health` for monitoring.
- The admin calls the server's `/rpc` with `ADMIN_API_TOKEN`. In every option below that call stays on a private network.
- People reach the admin in a browser. Its session cookie is `Secure` and its login rate limit trusts `X-Forwarded-For`, so the admin must sit behind HTTPS and a proxy you control, or be reachable on loopback only.

Both services refuse to start while a required variable is missing, and name it in the log.

## Docker Compose

```bash
cp .env.example .env    # fill in the secrets
docker compose up -d --build
```

- The server publishes port `3000` (`SERVER_PORT`) on all interfaces, so Sentry can reach it.
- The admin publishes port `3001` (`ADMIN_PORT`) on `127.0.0.1` only. From your machine open it through an SSH tunnel: `ssh -L 3001:127.0.0.1:3001 <vps>`, then http://localhost:3001.
- The sqlite file lives in the `data` volume and survives `docker compose down` and image updates. `docker compose down -v` deletes it.
- Update with `git pull && docker compose up -d --build`.

Use this option on a machine that already has a reverse proxy. Route `/webhooks/` and `/health` to the server, the admin's domain to the admin, and never route `/rpc` publicly.

## Docker Compose with Traefik (VPS)

`scripts/deploy-vps.sh` does the steps below on Ubuntu or Debian, including installing Docker and writing `.env`, and updates an existing install when run again. See the README for the one-line command. The manual steps:

1. Point two DNS A records at the VPS, one for the webhooks and one for the admin, for example `hooks.example.com` and `admin.example.com`.
2. Open ports 80 and 443. Port 80 is needed for the Let's Encrypt HTTP challenge and redirects to HTTPS.
3. In `.env` set `SERVER_DOMAIN`, `ADMIN_DOMAIN`, `ACME_EMAIL`, and uncomment `COMPOSE_FILE=docker-compose.yml:docker-compose.traefik.yml`.
4. `docker compose up -d --build`.

The webhook URL for Sentry is then `https://<SERVER_DOMAIN>/webhooks/sentry`.

- Traefik exposes only `/webhooks/*` and `/health` on `SERVER_DOMAIN`. Everything else on that domain, `/rpc` included, answers 404.
- The overlay removes the host ports of both services, so all traffic goes through Traefik.
- Certificates are stored in the `letsencrypt` volume. While testing, set `ACME_CA_SERVER` to the staging URL in `.env.example` to stay inside the Let's Encrypt rate limits, then remove it and delete the volume to get real certificates.
- Traefik reads the Docker socket to find the services. It needs v3.6 or newer with Docker Engine 29.

## DigitalOcean App Platform

```bash
doctl apps create --spec .do/app.yaml
```

Before that, edit `.do/app.yaml`: the `github.repo` of both services (your fork), `GITHUB_REPO`, `ADMIN_EMAIL` and, if needed, `region`. After the app is created, fill in the empty secrets in the control panel and redeploy. The DigitalOcean GitHub app needs access to the repository.

- One app with two services built from the same `Dockerfile`. The admin overrides the command with `run_command`.
- The app's domain routes `/webhooks` to the server and everything else to the admin. The webhook URL for Sentry is `https://<app domain>/webhooks/sentry`.
- The admin reaches the server through `${server.PRIVATE_URL}`, so `/rpc` is not public.

**No persistent disk.** App Platform containers have an ephemeral filesystem, so the sqlite file starts empty on every deploy and restart. That means:

- Logs and run history in the admin only cover the time since the last deploy.
- The claims that stop the same Sentry event from being processed twice are lost. A Sentry redelivery right after a deploy is processed again. The automation still looks for an open GitHub issue with the same Sentry ID before creating one, so this does not create a duplicate issue while the first one is open.
- GitHub Actions tracking is unaffected, since it reads from GitHub.

Keep `instance_count: 1` for the server. Each instance would have its own sqlite file. If you need lasting history, use the VPS option.

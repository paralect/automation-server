# Admin dashboard

Read-only dashboard for the automation server: overview stats, logs, runs and system state. Built with TanStack Start and shadcn/ui.

## Setup

1. On the automation server, set `ADMIN_API_TOKEN` (at least 32 random characters).
2. Copy `.env.example` to `.env.local` in this folder and fill it in.
3. From the repo root run `bun run dev` (starts the server and the admin), or `bun run dev` inside `apps/admin`. The admin listens on http://localhost:3001.

For production, `bun run build` then `bun run start` (serves `dist/` with Bun on `PORT`, default 3001). Bun loads `.env` files from this folder, or set the variables in the environment.

| Variable | Description |
| --- | --- |
| `AUTOMATION_SERVER_URL` | Base URL of the automation server. The admin calls `<url>/rpc`. |
| `ADMIN_API_TOKEN` | Must equal the server's `ADMIN_API_TOKEN`. Stays on the admin's server. |
| `ADMIN_EMAIL` | Email of the single admin login. |
| `ADMIN_PASSWORD` | Password of the single admin login. |
| `SESSION_SECRET` | Encrypts the session cookie. At least 32 characters, for example `openssl rand -base64 48`. |

The app validates these at the first request and fails with a message naming each bad variable.

## How auth works

There is no database. `ADMIN_EMAIL` and `ADMIN_PASSWORD` are compared with a timing-safe check (both sides hashed with SHA-256 first). A successful login sets an AES-256-GCM sealed cookie (`HttpOnly`, `SameSite=Lax`, `Secure` in production, 7 days). Failed logins are limited to 5 per 15 minutes per client IP, kept in memory, so the limit resets on restart and is per instance. The client IP is read from `X-Forwarded-For` when present, so run the admin behind a proxy you control.

The `_authed` route redirects to `/login` without a session, but routes are not the boundary. Every server function runs a session middleware, so a direct call to one without a cookie is rejected with `UNAUTHENTICATED`.

## Token boundary

The browser never sees `ADMIN_API_TOKEN`. Pages call TanStack Start server functions (`src/lib/api.functions.ts`), which build the oRPC client on the server (`src/server/automation-client.server.ts`) and add the bearer header. `*.server.ts` files are blocked from the client bundle, and the only import from `@automation-server/api` is a type.

Errors from the server functions are reduced to codes (`UNAUTHORIZED`, `UNREACHABLE`, `NOT_FOUND`, `SERVER_ERROR`) so the UI can tell a wrong token from an unreachable server.

## Layout

- `src/routes/_authed/` holds Overview, Logs, Runs, run detail and System.
- `src/lib/filters.ts` holds the zod schemas for URL search params. `src/lib/badge-styles.ts` maps status and level to badge styles.
- `src/components/ui/` is shadcn (preset `b1D0ekG8`). Add components with `bunx shadcn@latest add <name>` from this folder.

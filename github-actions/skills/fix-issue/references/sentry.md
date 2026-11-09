# Sentry issues

Read this when the issue has the label `sentry`, a `sentry.io` link, or a "Sentry Issue" marker in the body.

## Fields to expect in the body

Not every field is always present. Do not invent missing ones.

- Issue id or short id, and title
- Level and environment
- Release
- First seen, last seen, event count
- Stack trace
- Breadcrumbs
- Request and user tags
- Sentry URL

## Mapping frames to the repo

- Client frames are minified bundles. Sourcemaps come from Vite, so frames should already name `src/` files. If they name only bundle chunks, search the repo for the error message and function names instead.
- TanStack Start has a server side and a client side. Sentry setup lives in `src/instrument.server.ts` and `src/instrument.client.ts`. A frame in `src/routes/api.run.ts` or other server routes is server code.
- Errors from Convex functions come from `convex/`. The function name in the message or trace (for example `runs:streamInternal`) maps to `convex/<file>.ts` and the exported name.
- Frames in `node_modules` are context only. Find the nearest frame in our code.

## Triage order

1. Is it ours? If the top app frame is in `node_modules` and our call is correct, or the cause is a browser extension or bot, it is third-party.
2. Is it already fixed on main? Run `git log --oneline -n 30 -- <file>` and check the release against recent commits. If a fix landed, say so and make no change.
3. Can you reproduce it? Write a failing vitest test from the trace and the breadcrumbs.

## A good fix

- Fixes the first place the state went wrong, not the line that threw.
- Keeps the existing fallbacks for legacy rows (see "Schema facts" in `CLAUDE.md`).
- Adds a regression test that fails before the fix and passes after, built from synthetic data.

## When to decline

Make no change and explain why when the error is:

- not reproducible from the information given,
- configuration or infrastructure (missing env var, provider outage, quota),
- noise (extension errors, bots, aborted requests, network drops),
- dependent on user data you would have to copy to understand.

## PII

Sentry events can carry emails, ids, prompts, and file contents. Never copy user data into code, tests, commit text, or the PR body. Use synthetic values in tests. Refer to a user by "a user" and to an event by its short id.

## Extension point

A future workflow step may fetch the full event from the Sentry API using `SENTRY_AUTH_TOKEN` and write the event JSON next to `issue.md`. Until that exists, rely on the issue body alone. If an event file is present next to `issue.md`, read it, but apply the same PII rules.

# Architecture

The server is a Hono app on Bun, split into workspaces so that adding an integration touches one folder and one registry line.

| Package | Responsibility |
| --- | --- |
| `packages/core` | Generic types and machinery: `Event`, `Source`, `Automation`, `Job`, the dispatcher, the scheduler, the sqlite claim store, the sqlite activity store and the logger. Knows nothing about any specific service. |
| `packages/sources` | One folder per service that sends webhooks. Verifies the signature, parses the payload into an `Event`, optionally enriches it. |
| `packages/settings` | Projects, the settings store (sqlite, AES-256-GCM secrets), the typed `INTEGRATIONS` spec registry and the resolver that produces each integration's effective config. No runtime dependencies on the rest. |
| `packages/automations` | One folder per automation. Matches events and does the work. `registry.ts` lists them. |
| `packages/ledger` | What happened after a run: LLM calls, GitHub side effects, Codex PRs and workflow runs, and the work keys that join them. The read models the admin shows, the sqlite store and the GitHub sync job. See [Ledger](#ledger). |
| `apps/server` | HTTP wiring: `POST /webhooks/:project/:source`, config validation, startup, graceful shutdown, and the runtime that builds sources, automations and jobs from integration modules. |
| `packages/api` | oRPC routers, including the admin API over the activity store. |

## Projects

Everything an integration does belongs to a project: its settings, webhook sources, automations, jobs, runs and logs. One server hosts any number of projects, each with its own GitHub token, repositories, Sentry, Linear and PostHog.

- Projects live in the `projects` table of the settings database. A project has a slug `id` (from its name, never changes), a `name` and an optional `domain` whose favicon the admin shows as its icon.
- Setting keys are `<project>:<integration>.<field>`. Only the `default` project falls back to the legacy environment variables, so a new project starts empty. The default project cannot be deleted. Deleting another project removes its settings; its runs and logs stay until retention prunes them.
- The first start with projects moves everything into the `default` project: setting keys and claim keys gain the project prefix, and existing runs and logs get `project = 'default'`.
- `Event`, `Automation`, `Job`, runs and logs carry `project`. The dispatcher hands an event only to automations of the same project, and claims are keyed `<project>/<automation>:<externalId>`, so two projects never share a claim.
- Logs without a project (startup, reloads) are server-wide and show in every project.

## Request lifecycle

1. `POST /webhooks/:project/:source` looks the source up in that project (404 if either is unknown) and reads the body with a size cap (413 if exceeded). The older `POST /webhooks/:source` is the default project.
2. `Source.verify` checks the signature over the raw bytes (401 on failure).
3. `Source.parse` produces an `Event { source, kind, externalId, payload }`.
4. The server logs `webhook received` and responds `200`. Everything after this runs in the background.
5. The dispatcher finds every automation whose `matches` accepts the event and claims `(automation, externalId)` in sqlite. An existing claim means a duplicate, which is skipped and recorded as a `duplicate` run.
6. A successful claim starts a run (`running`). Every log line of the automation carries its `runId`.
7. The automation runs. On success the run becomes `succeeded`. If it throws, the run becomes `failed` with the error message and the claim is released so a redelivery can retry.

## Activity store and admin API

The user-facing side of this (statuses, log messages, how to trace one event) is in [observability.md](observability.md). Failure handling, claims and partial runs are in [reliability.md](reliability.md).

Every log line is written to stdout and also recorded in the `logs` table. Every automation run, including duplicates, is a row in the `runs` table. Both tables live in the same sqlite file as the claims (`DATABASE_PATH`), each behind its own connection. `source`, `automation`, `externalId` and `runId` are lifted out of the log fields into indexed columns, and the full fields are kept as JSON.

- Runs still `running` at startup are marked `failed` with `interrupted by server restart`.
- Logs and finished runs older than `LOG_RETENTION_DAYS` are pruned at startup and every hour. The ledger has its own retention, `LEDGER_RETENTION_DAYS`.
- Recording is best effort. A failing activity store is logged to stdout and never blocks dispatching.
- `projects.list`, `projects.create({ name, domain? })`, `projects.update({ id, name?, domain? })` and `projects.delete({ id })` manage projects. Every other procedure takes a `project` and answers 404 for an unknown one.
- The admin API (`overview`, `logs.list`, `runs.list`, `runs.get`, `system`, `settings.get`, `settings.update`, `settings.testConnection`) is served by oRPC under `/rpc` and requires `Authorization: Bearer <ADMIN_API_TOKEN>`. It answers 401 to every request while `ADMIN_API_TOKEN` is unset.
- `runs.trace`, `outcomes.summary`, `outcomes.pullRequests`, `outcomes.syncNow` and `costs.month` read the ledger. See [Ledger](#ledger).
- `actions.list` and `actions.get` read GitHub Actions workflow runs, with their jobs and steps, from the GitHub REST API using the project's GitHub token. The repositories come from the project's Actions repositories (default its issues repository), and the token needs Actions: Read on each. Nothing is stored: GitHub stays the source of truth. Responses are cached for 4 seconds and the workflow list for 5 minutes, so several open admin tabs share one GitHub request. A repository the token cannot read is reported next to the runs of the others, not as a failure of the whole list. `actions.get` answers 404 for a repository outside the list.
- To fill the dashboard with sample data, start a local server and run `bun apps/server/scripts/demo-traffic.ts` with the same `SENTRY_CLIENT_SECRET` (optional `SERVER_URL`, default `http://localhost:3000`).

- `settings.get` returns every integration with its fields, the effective value of non-secret fields, where each value comes from and whether the integration is configured. `settings.update({ integrationId, values, clear? })` validates against the spec, stores a secret only for a non-empty string, removes the keys in `clear` and rebuilds the runtime. `settings.testConnection({ integrationId })` calls the module's `test` hook (implemented for `github`, `linear`, `posthog`, `openrouter` and `crisp`, answering `available: false` for the rest).
- `system` returns the project's sources, automations, jobs and `webhookUrls` (`/webhooks/<project>/<source>`), built from the optional `PUBLIC_URL` (relative paths when it is unset).
- `workflows.templates`, `workflows.status({ repo })` and `workflows.install({ repo, templateId, mode })` install the workflows from `github-actions/` into a repository with the GitHub token from settings, which needs Contents, Pull requests and Workflows write access there. See [Workflow install](#workflow-install).

The admin UI lives in `apps/admin`.

## Settings and integration modules

Integrations are configured through settings, not only environment variables.

- `INTEGRATIONS` in `packages/settings/src/spec.ts` is the domain model: one spec per integration (`github`, `sentry`, `linear`, `posthog`, `openrouter`, `crisp`) listing its fields (`text`, `secret`, `number`, `boolean`, `select`, `list`). Validation, the admin form and the resolved types are all derived from it.
- The effective value of a field is the project's settings table value, else, for the default project only, the legacy environment variable (the field's `env`), else the spec default. An empty environment variable counts as unset. Existing env-only deployments therefore behave as before.
- An integration whose required fields are all present is `configured`. An unconfigured integration is simply not registered, so the server boots with no integration env at all.
- Settings live in the `settings` table of the same sqlite file. Secret values are encrypted with AES-256-GCM using a key derived (HKDF-SHA256) from `SETTINGS_ENCRYPTION_KEY`. Without that variable, plain settings work and writing a secret is rejected. Secrets are write-only: the API reports only whether one is set, and from where (`db`, `env`, `default`, `unset`). A secret that cannot be decrypted (key changed) is treated as unset.
- `apps/server/src/integrations/registry.ts` lists the `IntegrationModule`s. A module's `build(resolvedConfig, deps)` returns the `sources`, `automations` and `jobs` it contributes, and its optional `test` hook backs `settings.testConnection`. Modules for unconfigured integrations are skipped, and a module that throws is logged and skipped.
- The runtime holder builds all modules for every project at boot and again after every settings or project change, then swaps one immutable snapshot. Each project's automations and jobs are tagged with the project. The dispatcher, the webhook routes and the admin API read through getters, so a saved setting applies to the next event or request without a restart. Runs already in flight finish on the snapshot they started with.

## Scheduler

`Job { name, due(now) => claimKey | null, run(ctx) }` in `packages/core`. The server ticks every 60 seconds. For each job whose `due` returns a key, the scheduler claims `(job name, key)` in the claim store, so an occurrence runs at most once, also across restarts. A run is recorded in the activity store with source `schedule`, so it shows on the Runs and Logs pages like an automation run. A failed occurrence is recorded as failed and not retried by the ticker, to avoid one failing call per minute. `Scheduler.runNow(jobOrName, key)` runs a job under an explicit key (for example `manual:<timestamp>`) through the same recording. It also accepts a job object that is not on the schedule, so the admin can run a disabled job. Shutdown stops the ticker and drains running jobs.

## Ledger

The activity store records what the server did. The ledger records what happened after: every LLM call, every GitHub write, and the Codex PRs and workflow runs those writes led to. The user-facing side is in [observability.md](observability.md#what-a-run-led-to).

- **Run scope.** The dispatcher and the scheduler run each automation and job inside `runInScope` (`packages/core/src/runScope.ts`, an `AsyncLocalStorage`). `currentRun()` returns the run on the current async stack. LLM and GitHub clients are built once per module build, not per run, so this is how a call made deep inside the Slack agent loop still lands on its run. Only the dispatcher and the scheduler open a scope, and only observers read it. Automations get their run through `ctx` as before.
- **Observers.** `createOpenRouterClient` and `createGithubClient` take a required `observe: Observer`. After a successful call the OpenRouter client reports the usage OpenRouter returned (it asks for it with `usage: { include: true }`), and the GitHub client reports `issue_created` and `workflow_dispatched`. The runtime gives every module the project's observer (`apps/server/src/ledgerObserver.ts`) as `deps.observe`. Tests, connection checks and read-only clients pass `UNOBSERVED`. The observer never throws: a failed write is logged and the automation goes on.
- **Work keys.** One string per unit of work, `gh:owner/repo#123` or `linear:ENG-42`, is the only join column between effects, workflow runs and PRs. The observer reduces dispatch inputs to a work key, plus a `linear.app` issue link, before anything is stored. Every rule that derives a key, from dispatch inputs, PR branches, titles and bodies, and run names, is in `packages/ledger/src/workKey.ts`.
- **Producers.** `PR_PRODUCERS` in `packages/ledger/src/producers.ts` maps each Codex workflow to the branch prefix it pushes. Only PRs on those branches are stored. A test reads `github-actions/*.yml` and fails when a workflow pushes a different branch.
- **Sync.** The GitHub module builds the `outcome-sync` job when the GitHub token is set. Its claim key is the hour (`2026-11-20T14`), so it runs once an hour across restarts. Per repository it pages `GET /pulls` by `updated_at` from a stored cursor (90 days on the first sync), reads the runs of each Codex workflow from two days before the last complete run read, links runs to work items (`exact`, then `titled`, then `linked`, never downgraded) and writes everything in one transaction. A read that hits its page cap (10 PR pages, 3 run pages per workflow) keeps its cursor and stores where it stopped, so the next sync continues there and nothing is skipped. Rows are upserted by natural key, so a repeated sync changes nothing. Every GitHub request times out after 15 seconds. One repository's error is stored on that repository; the run fails only when every repository failed. Workflow runs the token cannot read do not hold back that repository's PRs: the PRs are applied and the run error is stored as the repository's error. `outcomes.syncNow` runs the same job through `Scheduler.runNow` with a `manual:<timestamp>` key.
- **Origin** is derived when read, never stored: the earliest effect that carries the PR's work key names the automation, else the PR's workflow gets the credit.
- **Budget.** After each recorded LLM call the observer starts a budget check. The check compares month-to-date spend with `openrouter.monthlyBudgetUsd` and, for each reached threshold (80 and 100), claims a `(project, month, threshold)` row in `budget_alerts` before it posts to the Slack alerts webhook. A failed post releases the row so the next call retries. Nothing else frees a claim, so an alert is sent at most once: a crash between the claim and the post loses that alert rather than risk a second one.
- **Storage.** The ledger is one sqlite component (`ledger`) in `DATABASE_PATH` with the tables `llm_calls`, `run_effects`, `workflow_runs`, `pull_requests`, `sync_state` and `budget_alerts`. Money is stored as integer micro-dollars. Facts carry their `run_id` and `automation`, so attribution survives the run being pruned. `runs.trace` itself answers only for runs the activity store still has. The hourly prune deletes ledger rows older than `LEDGER_RETENTION_DAYS` (default 400), except PRs that are still open and the effects on the work key of a PR that is kept, which name its origin.
- To fill the Outcomes and Costs pages with sample data, run `DATABASE_PATH=<new file> bun apps/server/scripts/demo-ledger.ts`. It refuses a file that already exists, such as the server's own database that Bun loads from `.env`, unless `DEMO_FORCE=1` is set.

## Principles

- Verify before parsing, parse before dispatching.
- Respond to the sender fast; do slow work in the background and drain it on shutdown.
- Secrets and raw payloads are never logged.
- Core stays service-agnostic. Service-specific code lives in `sources/<service>` and `automations/<name>`.

## Workflow install

The admin can add a workflow from `github-actions/` to any repository the GitHub token can write to.

- The templates are bundled into the server as TypeScript strings in `packages/api/src/workflowTemplates.generated.ts`, so the image does not need the `github-actions/` folder. `bun run generate:workflows` rewrites that file from every top-level `.yml` and everything under `skills/`, and a test fails when it is out of date.
- `TEMPLATE_META` in `packages/api/src/workflowTemplates.ts` gives each workflow file its title, description, skill folder and required secrets and variables. A workflow file without an entry fails the tests. A template installs its workflow to `.github/workflows/` and its skill to `.agents/skills/<name>/`.
- `workflows.status` compares each template file with the default branch by git blob sha and reports `installed`, `differs` or `missing`, plus an open install PR.
- `workflows.install` with `mode: "pr"` (the default) writes the files that differ to the branch `automation-server/install-<templateId>` through the contents API and opens a PR. Running it again reuses the open PR and only rewrites files that changed. `mode: "direct"` commits to the default branch. When the default branch already has every file, nothing is written.

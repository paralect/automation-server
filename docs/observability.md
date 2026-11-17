# Observability: logs and runs

Automations work in the background, after the sender has already got its `200`. To show what they did, the server records every **run** (one automation handling one event) and every **log line**, and shows both in the admin. What the server does when a run fails is in [reliability.md](reliability.md).

## Runs

![The Runs page: filters for status, automation, source and search, and one row per run with its status, automation, source and kind, external id, start time, duration and error](setup/img/admin-13-runs.png)

Each row is one automation handling one event. A webhook that two automations match gives two rows. Scheduled jobs show here too, with source `schedule` and the week (`2026-W46`) as the external id. Click a row to open the run: its error, its result and all of its log lines in order.

| Status | Meaning |
| --- | --- |
| `running` | Working right now. If the server restarts during the run, it becomes `failed` with `interrupted by server restart`. |
| `succeeded` | Finished without an error. It may have done nothing on purpose, for example a filtered Sentry level or an issue that already exists. The run's log lines say which. |
| `failed` | Threw an error. The message is in the Error column. It usually names what to fix: a token, a permission, a missing workflow. |
| `duplicate` | The event was already handled by this automation, so it was skipped. This is normal when a sender redelivers. |

For `linear-label-to-pr` and the Crisp `fix` decision, `succeeded` means only that the GitHub workflow was started. Whether Codex opened a pull request shows on the **GitHub Actions** page.

The **Overview** page sums this up for the last 24 hours or 7 days: counts by status, a chart of runs and the latest failures. Open it first.

## Logs

![The Logs page: filters (1), the Live switch (2), the run id of each line (3) and the expanded fields of an "automation failed" line with its error (4)](setup/img/admin-15-logs.png)

1. **Filters:** level, source, automation, run id, and a search over message, external id and automation.
2. **Live** refreshes the list every 5 seconds. Turn it on while you send a test webhook.
3. **Run:** every line written during a run carries its `runId`. Click it to open the run.
4. **Fields:** the structured data of the line. Here an `automation failed` line shows the error.

A line looks like `{"time", "level", "message", ...fields}`. Every line written during a run gets `project`, `automation`, `externalId` and `runId` automatically. Lines from the webhook route (`webhook received`) carry `source`, `kind` and `externalId`.

### Following one event

1. **Logs**: search for the external id (a Sentry issue id, a Linear identifier like `ENG-42`, a Crisp session id). You get `webhook received` and the lines of every run it started.
2. **Run**: click the run id to see the status, the error and the lines of that run.
3. **GitHub Actions**: if the run started a workflow, find that workflow run there by its time.

### Messages to know

| Message | Level | Meaning |
| --- | --- | --- |
| `webhook received` | info | Signature valid, `200` sent, work queued. |
| `webhook ignored` | info | Valid, but nothing handles this kind of payload. `reason` says why. |
| `webhook signature rejected` | warn | `401` sent. Usually a wrong or rotated secret. |
| `duplicate skipped` | info | The event was already handled. |
| `prepare failed, continuing with original event` | warn | Enrichment failed (for example the Sentry event count). The run used the event without it. |
| `automation failed` / `job failed` | error | A run failed. `error` holds the reason. |
| `claim failed`, `activity … failed` | error | sqlite itself failed. See [reliability.md](reliability.md#when-the-machinery-itself-fails). |

Each automation's own messages (`created github issue`, `dispatched workflow`, `triaged` and so on) are on its [integration page](integrations).

## Where it is stored

- Every line goes to **stdout** as JSON, which is what `docker logs` and a log collector see. It also goes to the `logs` table in sqlite, which the admin reads. If the sqlite write fails, the stdout line is still written.
- Runs and logs live in the same file as everything else (`DATABASE_PATH`). They are deleted after `LOG_RETENTION_DAYS` (default `30`), checked at startup and every hour.
- Secrets and raw webhook payloads are never logged. Crisp and Sentry text is redacted (tokens, the customer's email) before it reaches a log line or a GitHub issue. When you write an automation, log ids and decisions, not payloads.

## Alerts outside the admin

- **Uptime:** `GET /health` returns `{"status":"ok"}`.
- **Failures:** alert on stdout lines with `"message":"automation failed"` or `"message":"job failed"`.
- **Secrets after a deploy:** a burst of `webhook signature rejected` means a secret did not reach the new environment.
- **Polling:** the `overview` API (with `ADMIN_API_TOKEN`) returns the same counts as the Overview page.

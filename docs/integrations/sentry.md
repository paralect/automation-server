# Sentry integration

Turns a Sentry issue alert into one GitHub issue, labelled `sentry`, so that a GitHub Action watching that label can pick it up from there (see [github-actions](../../github-actions/README.md)).

- Source: `packages/sources/src/sentry`, served at `POST /webhooks/sentry`.
- Automation: `packages/automations/src/sentryToGithubIssue`, named `sentry-to-github-issue`.

Sentry expects a response within about one second, so the server answers `200` as soon as the signature checks out and the event is parsed. Enrichment and the GitHub calls run in the background and are drained on shutdown.

## Behavior

- **One GitHub issue per Sentry issue.** The issue body carries a `Sentry Issue: <id>` marker. Before creating, the automation looks through the repo's open issues labelled `sentry` for that marker. Deliveries are also deduplicated by a sqlite claim, so a redelivered alert is skipped. A failed run releases its claim, so a redelivery can retry.
- **Filters.** `SENTRY_LEVELS` (default `error,fatal`), `SENTRY_ENVIRONMENTS` (empty means all) and `SENTRY_MIN_EVENT_COUNT` (default `1`).
- **Event count needs a token.** The `event_alert` payload has no event count, first seen or last seen. Those come from the Sentry API, so set `SENTRY_AUTH_TOKEN` to enable them. Without it, the count filter is not applied and the issue omits those stats.
- **Redaction.** Issue content is scrubbed of common secret shapes before it is sent to GitHub. Payload bodies and secrets are never logged.

## Setup

### Sentry

1. In Sentry, open Settings, then Developer Settings, then create a new Internal Integration.
2. Set the Webhook URL to `https://<your-host>/webhooks/<project>/sentry`. The admin Integrations page shows it per project. The default project also answers `/webhooks/sentry`.
3. Enable the Alert Rule Action toggle so the integration can be used as an alert action.
4. Save, then copy the Client Secret from the integration page. This is `SENTRY_CLIENT_SECRET`.
5. Create or edit an Issue Alert and add the action "Send a notification via <integration name>".
6. Optional: from the same integration page, copy a token for `SENTRY_AUTH_TOKEN`. Give it read access to Issue & Event.

These steps follow Sentry's [integration platform docs](https://docs.sentry.io/organization/integrations/integration-platform/). The docs confirm Developer Settings, the Client Secret signature, per-integration tokens and the "Send a notification via <your integration>" action. The Alert Rule Action toggle and the exact scope label were not found in the public docs text, so check them against your Sentry UI.

### GitHub

Create a fine-grained personal access token at Settings, Developer settings, Personal access tokens.

- Repository access: only the one repository that should receive issues.
- Repository permissions: Issues set to Read and write. Metadata is read-only and implicit.

## Configuration

Every value can also be saved from the admin API (`settings.update`), which takes effect without a restart and wins over the variable. A value that is neither saved nor set in the environment falls back to its default. The Sentry source registers once the client secret is set. Issues are created once `GITHUB_TOKEN` and `GITHUB_REPO` are set too.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `SENTRY_CLIENT_SECRET` | one of env or admin | | Client Secret of the Sentry integration. Verifies webhook signatures. |
| `GITHUB_TOKEN` | one of env or admin | | GitHub token with Issues: Read and write on the target repo. |
| `GITHUB_REPO` | one of env or admin | | Target repository as `owner/name`. |
| `SENTRY_AUTH_TOKEN` | no | | Enables issue stats enrichment (count, first and last seen). |
| `SENTRY_API_BASE_URL` | no | `https://sentry.io` | Sentry host. The token is only sent to this origin. |
| `SENTRY_LEVELS` | no | `error,fatal` | Comma-separated levels that create an issue. |
| `SENTRY_ENVIRONMENTS` | no | empty (all) | Comma-separated environments to handle. |
| `SENTRY_MIN_EVENT_COUNT` | no | `1` | Minimum event count, applied only when the count is known. |

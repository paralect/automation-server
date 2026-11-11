# Adding an integration

An integration is a source (incoming webhooks), an automation (what to do with events), or both.

## 1. A new source

Create `packages/sources/src/<service>/` with the same shape as `sentry/`:

- `source.ts` exports a `Source` with `verify(request)` (check the signature on `rawBody`) and `parse(request)` (return an `Event`).
- `event.ts` exports type guards such as `isSentryIssueAlert` for automations to match on.
- Test fixtures go in `packages/sources/test/fixtures/`.

Add its settings to `INTEGRATIONS` in `packages/settings/src/spec.ts` (one entry per field, with an `env` name only if it keeps a legacy variable). Then create `apps/server/src/integrations/<id>/index.ts` with `defineModule({ id, build, test? })`, where `build` returns `{ sources, automations, jobs }`, and add the module to `apps/server/src/integrations/registry.ts`. A source is served at `POST /webhooks/<name>` once the integration is configured, and appears or disappears when settings change, without a restart.

## 2. A new automation

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

Return it from your module's `build`. Throwing from `run` releases the claim so the delivery can be retried.

## 3. Document it

Add `docs/integrations/<name>.md` (setup steps, behavior, configuration table) and a row in the README integrations table.

## Checklist

- Signature verified on the raw body, constant-time comparison.
- Tests for parsing and for the automation, `bun run test` and `bun run check-types` pass.
- No secrets or payload bodies in logs.

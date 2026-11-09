# Adding an integration

An integration is a source (incoming webhooks), an automation (what to do with events), or both.

## 1. A new source

Create `packages/sources/src/<service>/` with the same shape as `sentry/`:

- `source.ts` exports a `Source` with `verify(request)` (check the signature on `rawBody`) and `parse(request)` (return an `Event`).
- `event.ts` exports type guards such as `isSentryIssueAlert` for automations to match on.
- Test fixtures go in `packages/sources/test/fixtures/`.

Register it in the `sources` map in `apps/server/src/index.ts`; it is then served at `POST /webhooks/<name>`. Add its environment variables to `apps/server/.env.schema` and `.env.example`, then run `bun run env:generate`.

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

Add it to `createAutomations` in `packages/automations/src/registry.ts`. Throwing from `run` releases the claim so the delivery can be retried.

## 3. Document it

Add `docs/integrations/<name>.md` (setup steps, behavior, configuration table) and a row in the README integrations table.

## Checklist

- Signature verified on the raw body, constant-time comparison.
- Tests for parsing and for the automation, `bun run test` and `bun run check-types` pass.
- No secrets or payload bodies in logs.

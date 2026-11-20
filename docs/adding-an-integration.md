# Adding an integration

An integration is a source (incoming webhooks), an automation (what to do with events), or both.

## 1. A new source

Create `packages/sources/src/<service>/` with the same shape as `sentry/`:

- `source.ts` exports a `Source` with `verify(request)` (check the signature on `rawBody`) and `parse(request)` (return an `Event`).
- `event.ts` exports type guards such as `isSentryIssueAlert` for automations to match on.
- Test fixtures go in `packages/sources/test/fixtures/`.

Add its settings to `INTEGRATIONS` in `packages/settings/src/spec.ts` (one entry per field, with an `env` name only if it keeps a legacy variable). Give every field a `group`: the admin shows each group as one section, in spec order, edited and saved on its own. Put a one-sentence `groupHelp` on the first field of a group when the section needs an explanation. Mark a field `advanced: true` instead of grouping it when it is rarely changed (an API base URL, a workflow file name): the admin folds those into one **Advanced** section at the end that says which fields differ from their defaults. Then create `apps/server/src/integrations/<id>/index.ts` with `defineModule({ id, build, test? })`, where `build` returns `{ sources, automations, jobs }`, and add the module to `apps/server/src/integrations/registry.ts`. A source is served at `POST /webhooks/<project>/<name>` once the integration is configured in that project, and appears or disappears when settings change, without a restart.

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

Return it from your module's `build`. Throwing from `run` releases the claim so the delivery can be retried. Before writing one that calls several services, read [reliability.md](reliability.md#writing-a-reliable-automation): what a failed or half-finished run leaves behind, and how to make a retry safe.

## 3. Document it

Add `docs/integrations/<name>.md` (setup steps, behavior, configuration table) and a row in the README integrations table.

## Checklist

- Signature verified on the raw body, constant-time comparison.
- Tests for parsing and for the automation, `bun run test` and `bun run check-types` pass.
- No secrets or payload bodies in logs ([what to log](observability.md#where-it-is-stored)).
- A retry after a partial run does not repeat its side effects ([reliability.md](reliability.md#partial-runs-by-automation)).

# GitHub Actions library

Workflow files kept here for reuse. They are **not active** in this repository: GitHub only runs files under `.github/workflows/`. To use one, copy it into the `.github/workflows/` directory of the target repository and adjust it.

| File | Purpose |
| --- | --- |
| [`codex-issue-fix.yml`](codex-issue-fix.yml) | Opens a draft PR with a Codex-written fix for each new issue. |

## Notes on `codex-issue-fix.yml`

Taken from another project and stored as-is. Before using it, adapt the project-specific parts: the install and build steps (`npm ci`, `npm run generate-routes`), the `$fix-issue` skill it invokes, and the docs reference in the header comment. It needs the `CODEX_AUTH_JSON` secret and refuses to run in public repositories.

Pairs with the [Sentry integration](../docs/integrations/sentry.md): issues created with the `sentry` label can trigger it.

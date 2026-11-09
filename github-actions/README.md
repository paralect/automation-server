# GitHub Actions library

Workflow files kept here for reuse. They are **not active** in this repository: GitHub only runs files under `.github/workflows/`. To use one, copy it into the `.github/workflows/` directory of the target repository and adjust it.

| File | Purpose |
| --- | --- |
| [`codex-issue-fix.yml`](codex-issue-fix.yml) | Opens a draft PR with a Codex-written fix for each new issue. |
| [`codex-seo-autopilot.yml`](codex-seo-autopilot.yml) | Daily run of the [seo-autopilot](https://il.ly/skills/seo-autopilot) skill with Codex. Opens one PR per run. |

## Notes on `codex-issue-fix.yml`

Taken from another project. Codex runs the `$fix-issue` skill, which is stored in [`skills/fix-issue`](skills/fix-issue). Copy that folder to `.agents/skills/fix-issue/` in the target repository, next to the workflow in `.github/workflows/`. The workflow does not install it, Codex finds it in the checkout.

The skill classifies the issue (bug, Sentry error, or too vague), finds the root cause, makes a minimal fix with a regression test, runs the checks and writes the PR body as its final message. Issues created by the [Sentry integration](../docs/integrations/sentry.md) carry the `sentry` label, so they take the Sentry path in `references/sentry.md`.

The skill and the workflow are still specific to the project they came from. Before using them elsewhere, adapt:

- The skill: the `CLAUDE.md` rules it names, the check commands (`npx tsc --noEmit`, `npx vitest run`, `npm run lint`), and `references/sentry.md`, which describes that project's frameworks and layout.
- The workflow: the install and build steps (`npm ci`, `npm run generate-routes`).

It needs the `CODEX_AUTH_JSON` secret and refuses to run in public repositories.

## Notes on `codex-seo-autopilot.yml`

Copy it into the marketing site's repository. It runs daily and on demand, and opens a new PR on a `seo-autopilot/<date>-<run id>` branch each time it changes something.

**Setup**

- Auth, one of: secret `OPENAI_API_KEY` (works in any repository), or secret `CODEX_AUTH_JSON` (private repositories only, with optional `GH_PAT_FOR_SECRET_WRITE` to store the rotated token).
- Repository variables: `SEO_SITE`, `SEO_PRODUCT`, `SEO_CONVERSION`, and optionally `SEO_COMPETITORS` (default "find them"). These are the skill's five setup lines. The ship mode is fixed to "PR for review". Optional `CODEX_MODEL`.
- Allow Actions to create pull requests in the repository settings.
- Adapt the dependency install step to the site's stack. The skill runs the repo's lint, type check and build before it ships.

**Behavior**

- The skill itself decides whether a run is daily, weekly or monthly, from the state it keeps in `seo/`.
- The skill has no license upstream, so it is not copied here. The workflow downloads it at a pinned commit and checks its SHA-256 before use. To upgrade, change `SKILL_REF` and `SKILL_SHA256` after reading the new version.
- A run is skipped while an earlier `seo-autopilot/*` PR is still open, because the state in `seo/` only exists on the default branch after a merge. Use the `force` input to override.
- The Codex step has network and web search enabled, and no GitHub token. The push and PR steps run afterwards, and refuse to push changes under `.github` or `.agents`. The checkout does not persist credentials.
- The model reads untrusted web pages while holding the OpenAI credential. Use a key with a spending limit.
- Not run end to end. `web_search` and `network_access` keys in the generated `config.toml` and the unattended skill run still need a first real run to confirm.

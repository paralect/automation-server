# Contributing

Thanks for helping out. New integrations are especially welcome.

## Setup

```bash
bun install
bun run test
bun run check-types
```

Requires Bun 1.4+. Copy `apps/server/.env.example` to `apps/server/.env.local` to run the server locally.

## Workflow

1. Open an issue first for anything bigger than a small fix, so the approach can be agreed.
2. Branch from `main`, keep changes focused.
3. Add or update tests. `bun run test` and `bun run check-types` must pass.
4. Update the docs if behavior or configuration changes.
5. Open a pull request using the template.

## Adding an integration

Follow [docs/adding-an-integration.md](docs/adding-an-integration.md). Keep `packages/core` service-agnostic; service-specific code belongs in `packages/sources/<service>` and `packages/automations/<name>`.

## Security

Never commit secrets or real webhook payloads. Scrub fixtures. Report vulnerabilities privately, see [SECURITY.md](SECURITY.md).

By contributing you agree your work is released under the [MIT license](LICENSE).

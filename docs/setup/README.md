# Setup guides

Step-by-step guides for connecting each service to automation-server. Every guide says what to open, what to click, what to copy, and which field in the admin Integrations page (or which environment variable) receives the value. Screenshots carry a red underline or box on the element that matters.

These guides cover setup only. For what each integration does once it runs, read [docs/integrations](../integrations).

## Where to start

1. Deploy the server and the admin first. See [docs/deployment.md](../deployment.md). Every webhook below needs a public HTTPS URL, so set `PUBLIC_URL`.
2. Sign in to the admin. Each service has a card on the Integrations page. Values saved there take effect without a restart and secrets are stored encrypted (this needs `SETTINGS_ENCRYPTION_KEY`).
3. Connect services in this order, since later ones reuse earlier ones.

| Order | Guide | You create | You paste into the admin |
| --- | --- | --- | --- |
| 1 | [GitHub](github.md) | Fine-grained token, repository secrets | GitHub token, repository |
| 2 | [OpenRouter](openrouter.md) | API key, credit limit | OpenRouter API key, models |
| 3 | [Sentry](sentry.md) | Internal integration, issue alert | Client secret |
| 4 | [Linear](linear.md) | Webhook, trigger label | Signing secret, trigger label, target repository |
| 5 | [Crisp](crisp.md) | Marketplace plugin, Web Hooks, `triage` segment | Plugin credentials, website ID, signing secret |
| 6 | [PostHog](posthog.md) | Personal API key, Slack webhook | Project ID, API key, Slack webhook URL |

## Which service needs which

| Integration | Needs GitHub | Needs OpenRouter |
| --- | --- | --- |
| Sentry to GitHub issue | yes | no |
| Linear label to PR | yes | no |
| Crisp triage | yes | yes |
| PostHog weekly report | no | no |

## Conventions in these guides

- `<your-host>` is your public server URL. `<project>` is the project slug from the admin (`default` unless you changed it).
- Placeholders such as `ghp_xxx` stand for secrets. Never commit a real one.
- A red underline or box marks the element to use. A red label gives the step number.
- Third-party UIs change. If a screenshot no longer matches, trust the text and the field names, then send a fix for the image.

## Updating screenshots

Annotate a new capture with the shared script. It underlines, boxes, labels, crops and blurs.

```bash
python3 scripts/annotate-screenshot.py raw.png docs/setup/img/<service>-NN-<slug>.png spec.json
```

The spec format is in the script's docstring. Blur every email, name, token and customer message before committing an image.

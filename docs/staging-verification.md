# Verify a deployment end to end

Use this checklist before a release, or before you trust a branch that touches webhooks, integrations or the admin. It stands up an isolated instance with throwaway accounts and walks every feature through the real admin and the real services. Unit tests cannot prove that a Slack signature, a GitHub token or a sqlite migration behave on a real host.

Sections marked **(newer features)** apply once the matching feature is in the build you deploy: run replay, dry-run, Slack failure alerts, token health, and the Slack bot.

## 1. Stand up an isolated instance

Use a separate host or a separate Compose project with its own `data` volume. Never point a test instance at a production database or production tokens.

```bash
git checkout <branch-to-verify>
cp .env.example .env
docker compose up -d --build
# with HTTPS, which Slack and Sentry require for webhook URLs:
# docker compose -f docker-compose.yml -f docker-compose.traefik.yml up -d --build
```

Set these in `.env` before the first start. See [deployment](deployment.md) for every option.

| Variable | Value for a test instance |
| --- | --- |
| `ADMIN_API_TOKEN` | A long random string. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | A throwaway login. Rotate it when the test ends. |
| `SESSION_SECRET` | A long random string. |
| `SETTINGS_ENCRYPTION_KEY` | A long random string. Without it the admin cannot save secrets. |
| `PUBLIC_URL` | The HTTPS URL services will call, for example `https://hooks.staging.example.com`. |
| `ADMIN_PUBLIC_URL` | The admin URL people open. Alerts use it to link to a run. |
| `TRUST_PROXY` | `true` only behind a proxy you control. |

Check it is up: `curl https://<PUBLIC_URL>/health` returns `{"status":"ok"}`.

## 2. Create throwaway accounts and scoped credentials

Create new, disposable resources. Give each credential the least access that the checks below need, and set an expiry where the service allows one.

| Service | Create | Minimum access |
| --- | --- | --- |
| GitHub | A sandbox repository and a fine-grained token limited to it, with an expiry date | Issues read and write, Actions read and write (to dispatch workflows), Contents read |
| OpenRouter | A key with a small credit limit | Default |
| Linear | A test team, a personal API key, and the trigger label from the Linear setup guide | The key acts as you, so use a test account if you can |
| Sentry | A test project, an internal integration with its client secret, and an auth token | Read on issues |
| Slack | A new free workspace and an app created from the manifest in the Slack bot setup guide | Scopes listed in that guide |

A fine-grained GitHub token is worth using on purpose. It is the only credential in this list that reports its own expiry date, so it is the one that exercises the token-health display.

## 3. Enter the secrets in the admin

Open the admin and fill each integration card. Do not paste secrets into chat, tickets, shell history shared with others, or the repository. Press **Test connection** on every card. Each one should report success without printing the secret.

## 4. Reach the admin safely

The admin listens on `127.0.0.1:3001` of the server by default. Do not expose it. Open an SSH tunnel from the machine whose browser will be used:

```bash
ssh -L 3001:127.0.0.1:3001 <user>@<server>
```

Then open http://localhost:3001. Anyone or anything driving that browser, including an automated assistant, reaches the admin through the tunnel and needs only the throwaway login from section 1.

## 5. Checks

Tick each box and note the run id or message you saw.

**Webhooks**

- [ ] A signed Sentry test alert creates one run and one GitHub issue in the sandbox repository.
- [ ] The same alert sent twice creates one run and one duplicate entry, not two issues.
- [ ] A request with a wrong signature gets `401` and creates no run.

**Run replay (newer features)**

- [ ] Break the GitHub token, trigger an alert, and see a failed run.
- [ ] Fix the token and press **Replay** on that run. A new run links back to the original and succeeds.
- [ ] A succeeded run cannot be replayed for real.
- [ ] The stored event shows no token or secret values.

**Dry-run (newer features)**

- [ ] **Dry run** on a finished run creates a run marked as a dry run and writes nothing to GitHub or Linear.
- [ ] A real replay afterwards still works.

**Failure alerts (newer features)**

- [ ] With the Slack webhook configured and a threshold of 2, two failing runs in a row post exactly one alert, and a third failure posts none.
- [ ] After a success, a new streak of two posts again.

**Token health (newer features)**

- [ ] The integrations list shows a health dot and an expiry badge for the GitHub token.
- [ ] Revoke a token, press **Test** on its tile, and see the dot turn red and one alert arrive.

**Slack bot (newer features)**

- [ ] Mention the bot from an allowed account and get a threaded answer that uses a read tool.
- [ ] Mention it from an account that is not on the allowlist and get one refusal and no tool call.
- [ ] Ask it to create a Linear issue. It posts the exact arguments and waits. Nothing is created yet.
- [ ] Reply `approve` from a different account. It is refused and nothing is created.
- [ ] Reply `approve` from the original account. Exactly one issue is created and the link is posted.
- [ ] Reply `approve` again. It says nothing is waiting.
- [ ] Propose again and reply `cancel`. Nothing is created.
- [ ] A hostile string such as `<!channel>` in an issue title comes back escaped and notifies nobody.

## 6. Read logs and data

```bash
docker compose logs -f server
docker compose cp server:/data/automation.db ./staging-check.db   # the image has no sqlite3, inspect the copy on your machine
sqlite3 ./staging-check.db '.tables'
```

Logs and the database must never contain a token, signing secret or webhook URL. After the run, search both for a distinctive part of each test secret, for example `docker compose logs server | grep -c '<fragment>'` and `strings ./staging-check.db | grep -c '<fragment>'`. Both counts should be `0`, except for secrets the admin stores encrypted, which appear only as ciphertext. Delete `staging-check.db` afterwards, and do not share logs or database files outside the team without scrubbing them.

## 7. Tear down

- [ ] Revoke the GitHub, Linear, Sentry and OpenRouter test credentials.
- [ ] Remove the Slack app, or delete the test workspace.
- [ ] `docker compose down -v` to delete the instance and its data.
- [ ] Rotate `ADMIN_PASSWORD` and `SESSION_SECRET` if the instance stays up.

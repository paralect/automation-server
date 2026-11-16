# Crisp integration

Turns a Crisp conversation into a triage verdict. An operator adds a segment to the conversation, the server classifies it with an LLM through OpenRouter and writes back a private note. Depending on the mode it also opens a GitHub issue or starts the Codex fix workflow, which opens a draft PR. The customer never gets a message from the server.

- Source: `packages/sources/src/crisp`, served at `POST /webhooks/<project>/crisp`.
- Automation: `packages/automations/src/crispTriage`, named `crisp-triage`.
- LLM: the `openrouter` integration (`packages/automations/src/openrouter.ts`).

## Behavior

1. **Trigger.** A `session:set_segments` delivery whose segments include the trigger segment (default `triage`, case-insensitive) starts a triage. With Triage resolved conversations on, a `session:set_state` delivery with state `resolved` does too. A conversation that already has a `triage:` status segment is skipped, and each session is triaged at most once per trigger kind (claim keys `<session>:triage` and `<session>:resolved`).
2. **Verify.** The signature is checked over the raw body and deliveries older than five minutes are rejected. Deliveries for another website ID are ignored. The server answers `200` before any slow work.
3. **Load.** The source loads the conversation and its latest batch of messages through the Crisp REST API. User and operator text messages and operator notes are kept. The server's own notes, files and other message types are not.
4. **Redact.** Emails, phone numbers, card numbers, IPs and secret shapes are removed before anything reaches the LLM or GitHub. The customer's email is only used on the server.
5. **Rules before the model.** An open GitHub issue labelled `crisp` whose body has the line `Crisp Session: <session>` drops the request as a duplicate. A conversation without customer text becomes `needs_info`. Neither calls the LLM.
6. **Classify.** The triage model returns a structured verdict: category, confidence, severity, area (one of the configured areas or `unknown`), summary, reproduction steps, missing information, evidence quotes and, for how-to questions, a draft answer. When the confidence is below the minimum, or the category is `bug`, `regression` or `data_fix`, the escalation model classifies it again. A reply that is not valid JSON or does not match the schema fails the run.
7. **Route.** One ordered table, first match wins:

   | Condition | Decision |
   | --- | --- |
   | spam | drop |
   | bug or regression with missing information or no repro, or confidence below the minimum | needs_info |
   | how_to | answer (draft in the note) |
   | feature_request, performance, data_fix, account_billing | issue |
   | bug or regression, not a blocker, area in Autofix areas | fix |
   | bug or regression | issue |
   | anything else | issue labelled `triage-unsure` |

8. **Mode.** `shadow` only reports the decision in Crisp. `issue` turns a fix into an issue. `fix` acts on the decision as routed.
9. **Effects.** For issue and fix the server creates one GitHub issue in the GitHub integration's issues repository, labelled `crisp`, `area:<area>`, `severity:<severity>` plus the decision's labels (`bug`, `feature-request`, `performance`, `data`, `account-billing`, `triage-unsure`). The body has the `Crisp Session` marker, a link to the conversation in the Crisp inbox, the summary, repro, evidence and the classifier verdict with model and triage version. No customer name or email. A fix also gets the `autofix` label and dispatches the fix workflow on the default branch with input `issue_number`. Then, in every mode, the server posts a private note starting with `[automation-server triage]` and adds the status segment `triage:<decision>` (`triage:drop`, `triage:needs-info`, `triage:answer`, `triage:issue`, `triage:fix`).

Only the verdict fields are logged, never message bodies.

### The fix workflow

`codex-issue-fix.yml` accepts `workflow_dispatch` with `issue_number`. Issues labelled `crisp` are skipped when they are opened, so only the ones the triage routes to a fix reach Codex. For those, the `fix-issue` skill must first write a regression test that fails for the reported reason. If it cannot, it changes nothing and says why. Install the workflow from the admin Workflows page.

## Setup

### Crisp

1. In the [Crisp Marketplace](https://marketplace.crisp.chat/), create a plugin.
2. Request a production token for it with conversation read and write scopes (read the conversation and its messages, write notes and segments, which Crisp calls conversation meta). Copy the token identifier and key.
3. Under Web Hooks, add the URL `https://<your-host>/webhooks/<project>/crisp` for the events `session:set_segments` and `session:set_state`. The admin Integrations page shows the URL per project. Copy the signing secret.
4. Install the plugin on your website and copy the Website ID from the website settings.
5. Agree with support on the trigger segment name. The server only adds segments that start with `triage:`.

### OpenRouter

Create an API key at OpenRouter with a credit limit and save it on the OpenRouter integration. The default models are `anthropic/claude-haiku-5.5` for the first pass and `anthropic/claude-sonnet-5.5` for escalation. Any model that supports structured outputs works. Requests set `provider.require_parameters`, so a provider without structured outputs is never used.

### GitHub

Modes `issue` and `fix` need the GitHub token and the issues repository on the GitHub integration. The token needs Issues: Read and write and, for `fix`, Actions: Read and write. Shadow mode works without GitHub. When GitHub is set, shadow mode still reads open issues to find duplicates.

## Configuration

Crisp settings are saved from the admin. The webhook is served once the four required fields are set. The triage runs once OpenRouter is configured too, and for modes `issue` and `fix` once GitHub has a token and an issues repository.

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| Website ID | yes | | Crisp website the plugin is installed on. Deliveries for other websites are ignored. |
| Plugin token identifier | yes | | Identifier of the plugin's production token. |
| Plugin token key | yes | | Key of the plugin's production token. |
| Web Hooks signing secret | yes | | Verifies `X-Crisp-Signature`. |
| Trigger segment | no | `triage` | Adding it to a conversation starts the triage. |
| Triage resolved conversations | no | `false` | Also triage every conversation marked resolved. |
| Mode | no | `shadow` | `shadow`, `issue` or `fix`. |
| Minimum confidence | no | `0.7` | Between 0 and 1. Below it the decision is `needs_info`, and the escalation model is asked. |
| Product areas | no | empty | The closed list the classifier picks the area from. |
| Autofix areas | no | empty | Areas whose non-blocker bugs go to the fix workflow. Empty means no fixes. |
| Workflow file | no | `codex-issue-fix.yml` | Workflow dispatched for a fix. |

| OpenRouter field | Required | Default |
| --- | --- | --- |
| API key | yes | |
| Triage model | no | `anthropic/claude-haiku-5.5` |
| Escalation model | no | `anthropic/claude-sonnet-5.5` |

## To verify against a real delivery

These follow Crisp's documentation by name but their exact shape is not documented. Check them on a test website before turning on `issue` or `fix`.

- **Signature encoding.** The server compares `X-Crisp-Signature` as a hex HMAC-SHA256 of `[<timestamp>;<raw body>]`. If real deliveries are rejected with 401, the encoding is the first suspect. It is one constant in `packages/sources/src/crisp/signature.ts`.
- **Timestamp unit.** `X-Crisp-Request-Timestamp` is read as milliseconds. A value that looks like seconds is accepted too.
- **Segments payload.** `session:set_segments` is read as carrying the segments of the conversation. Status segments are also checked on the loaded conversation, so a delivery with only the added segments works as well.
- **Note and segment requests.** The note is sent as `POST /website/{website}/conversation/{session}/message` with `{ type: "note", from: "operator", origin: "chat", content }`. Segments are written with `PATCH /website/{website}/conversation/{session}/meta` and `{ segments }`, which replaces the list, so the server sends the existing segments plus its status segment. Both live in `packages/sources/src/crisp/client.ts`.
- **Inbox link.** The issue links to `https://app.crisp.chat/website/{website}/inbox/{session}/`, the address the Crisp inbox uses. It is not part of the API docs.
- **Token scopes.** The exact scope names for reading conversations and writing notes and meta.

## Limits

- Only the latest five pages of messages (about 100) are read.
- Attachments are never sent to the LLM or GitHub.
- If starting the fix workflow fails, the note says so and the run fails. The issue exists, so run the workflow by hand for it. GitHub keeps one pending run per concurrency group, so a burst of fixes can drop a queued one. Otherwise a failed run releases its claim, but Crisp does not redeliver. Remove the status segment if any, then remove and re-add the trigger segment to retry. When the issue was already created, the retry finds it and drops the request as a duplicate.

# Linear integration

Adding the trigger label to a Linear issue starts a GitHub Actions workflow in the target repository. Codex implements the task there and the workflow opens a PR that Linear links back to the issue.

- Source: `packages/sources/src/linear`, served at `POST /webhooks/linear`.
- Automation: `packages/automations/src/linearLabelToPr`, named `linear-label-to-pr`.
- Workflow: [`github-actions/linear-implement.yml`](../../github-actions/linear-implement.yml) with the [`implement-task`](../../github-actions/skills/implement-task) skill.

The server answers `200` as soon as the signature checks out and the event is parsed. The GitHub call runs in the background.

## Behavior

- **Signature and replay.** The `Linear-Signature` header must be the hex HMAC-SHA256 of the raw body with the webhook secret, compared in constant time. A delivery whose `webhookTimestamp` is more than 60 seconds away from the server clock is rejected with `401`.
- **Only a newly added label triggers.** Issue `update` webhooks count a label as added when it is in `labelIds` but not in `updatedFrom.labelIds`. On `create`, every label on the new issue counts as added. Other changes, other entity types and `remove` are ignored. The label name is matched case-insensitively against the trigger label.
- **Deduplication.** The claim key is the issue id, the added label ids and the issue's `updatedAt`. A redelivery of the same webhook is skipped. Removing the label and adding it again later starts a new run. A failed run releases its claim, so a redelivery can retry.
- **Dispatch.** The automation calls `POST /repos/{owner}/{repo}/actions/workflows/{workflowFile}/dispatches` with `ref` (the configured ref, or the repository's default branch) and these inputs:

  | Input | Value |
  | --- | --- |
  | `issue_identifier` | Issue identifier, such as `ENG-42` |
  | `issue_title` | Issue title |
  | `issue_url` | Link to the issue in Linear |
  | `issue_description` | Issue description in Markdown |

  GitHub limits a dispatch to 65,535 characters of inputs. A longer description is cut to fit, ends with a note that links the issue, and the run logs a warning with the original and new lengths.
- **Actionable errors.** A `404` from GitHub means the workflow is not installed in the target repository (or the token cannot see it). A `422` means the workflow has no `workflow_dispatch` trigger or the ref does not exist. A `401` or `403` means the token lacks Actions write access. Each fails the run with a message that says what to do, pointing at the admin Workflows page where relevant, and shows on the Runs page.
- **Logs.** The issue identifier, repository, workflow and ref are logged. The issue description, the webhook secret and the GitHub token never are.

## Setup

### Target repository

1. Install `linear-implement.yml` and the `implement-task` skill from the admin Workflows page, or copy them by hand as described in [github-actions/README.md](../../github-actions/README.md).
2. Add the `CODEX_AUTH_JSON` secret. The workflow refuses to run in a public repository.
3. Allow Actions to create pull requests in the repository settings.

### GitHub token

The integration uses the token from the GitHub integration. Give it Actions: Read and write on the target repository, so it can dispatch the workflow, and Metadata: Read. Installing workflows from the admin needs Contents, Pull requests and Workflows write as well.

### Linear

1. In Linear, open Settings, then API, then Webhooks, and create a webhook.
2. Set the URL to `https://<your-host>/webhooks/<project>/linear` (the default project also answers `/webhooks/linear`). The admin Integrations page shows the full URL when `PUBLIC_URL` is set.
3. Select the Issues resource type. Pick the teams that should be able to trigger it.
4. Copy the signing secret into the Linear integration's webhook secret in the admin.
5. Create the trigger label, for example `codex`, and set the same name as the trigger label in the admin.

"Test connection" in the admin checks that the GitHub token is set and that the workflow is installed and active in the target repository.

## Configuration

All values are saved from the admin Integrations page (or `settings.update`) and take effect without a restart. There are no environment variables for Linear. The source registers once the webhook secret, trigger label and target repository are set. The automation registers once the GitHub token is set too.

| Setting | Required | Default | Description |
| --- | --- | --- | --- |
| `linear.webhookSecret` | yes | | Signing secret of the Linear webhook. Stored encrypted. |
| `linear.triggerLabel` | yes | | Label name that starts an implementation. Case-insensitive. |
| `linear.targetRepo` | yes | | `owner/name` of the repository with the workflow installed. |
| `linear.workflowFile` | no | `linear-implement.yml` | Workflow file name in `.github/workflows/`. |
| `linear.ref` | no | empty | Branch to run the workflow on and open the PR against. Empty means the default branch. |
| `github.token` | yes | | From the GitHub integration (`GITHUB_TOKEN` also works). |

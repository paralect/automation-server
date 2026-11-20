import { defineAutomation } from "@automation-server/core/automation";
import { isLinearIssue } from "@automation-server/sources/linear/event";
import { createGithubClient, GithubApiError } from "../github";
export const LINEAR_LABEL_TO_PR = "linear-label-to-pr";
export const MAX_INPUT_CHARS = 60_000;
export function addedTriggerLabel(issue, triggerLabel) {
    const wanted = triggerLabel.trim().toLowerCase();
    if (wanted === "")
        return false;
    return issue.labels.some((l) => issue.addedLabelIds.includes(l.id) && l.name.trim().toLowerCase() === wanted);
}
export function workflowInputs(issue) {
    const fixed = { issue_identifier: issue.identifier, issue_title: issue.title, issue_url: issue.url };
    const budget = MAX_INPUT_CHARS - Object.values(fixed).reduce((n, v) => n + v.length, 0);
    const full = issue.description;
    if (full.length <= budget)
        return { inputs: { ...fixed, issue_description: full }, truncatedFrom: null };
    const note = `\n\n[Description truncated from ${full.length} characters. Read the full issue at ${issue.url}]`;
    return {
        inputs: { ...fixed, issue_description: full.slice(0, Math.max(0, budget - note.length)) + note },
        truncatedFrom: full.length,
    };
}
function actionable(err, config, ref) {
    if (!(err instanceof GithubApiError))
        return err;
    const repo = `${config.repo.owner}/${config.repo.name}`;
    const file = config.workflowFile;
    switch (err.status) {
        case 404:
            return new Error(`Workflow ${file} was not found in ${repo}, or the GitHub token cannot see that repository. Install it from the admin Workflows page. (${err.message})`);
        case 422:
            return new Error(`GitHub refused to dispatch ${file} in ${repo} on ref "${ref ?? "default branch"}": the workflow has no workflow_dispatch trigger or the ref does not exist. Reinstall it from the admin Workflows page and check the Linear ref setting. (${err.message})`);
        case 401:
        case 403:
            return new Error(`The GitHub token cannot dispatch workflows in ${repo}. It needs Actions: Read and write on that repository. (${err.message})`);
        default:
            return err;
    }
}
export function createLinearLabelToPr(config) {
    const github = createGithubClient(config);
    const matches = (event) => isLinearIssue(event) && addedTriggerLabel(event.payload, config.triggerLabel);
    return defineAutomation({
        name: LINEAR_LABEL_TO_PR,
        matches,
        async run(event, { log, dryRun }) {
            const issue = event.payload;
            const { inputs, truncatedFrom } = workflowInputs(issue);
            if (truncatedFrom !== null) {
                log.warn("issue description truncated for workflow inputs", {
                    identifier: issue.identifier,
                    from: truncatedFrom,
                    to: inputs.issue_description.length,
                });
            }
            let ref = config.ref.trim() || null;
            try {
                ref ??= await github.defaultBranch();
                if (!dryRun)
                    await github.dispatchWorkflow(config.workflowFile, ref, inputs);
            }
            catch (err) {
                throw actionable(err, config, ref);
            }
            if (dryRun) {
                log.info("dry-run: would dispatch workflow", {
                    identifier: issue.identifier,
                    repo: `${config.repo.owner}/${config.repo.name}`,
                    workflow: config.workflowFile,
                    ref,
                });
                return;
            }
            log.info("dispatched workflow", {
                identifier: issue.identifier,
                repo: `${config.repo.owner}/${config.repo.name}`,
                workflow: config.workflowFile,
                ref,
            });
        },
    });
}

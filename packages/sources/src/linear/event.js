export const LINEAR_SOURCE = "linear";
export const LINEAR_ISSUE = "issue";
export function isLinearIssue(event) {
    return event.source === LINEAR_SOURCE && event.kind === LINEAR_ISSUE;
}

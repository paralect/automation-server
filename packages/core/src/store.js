export function claimKey(automation, externalId, project) {
    return `${project ? `${project}/` : ""}${automation}:${externalId}`;
}

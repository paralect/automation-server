export const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export function templateFor(integrationId, templates) {
    return templates?.find((t) => t.integration?.integration === integrationId);
}
export function fieldOf(integrations, integrationId, key) {
    return integrations.find((i) => i.id === integrationId)?.fields.find((f) => f.key === key);
}
export function savedRepo(template, integrations) {
    const { integration, key } = template.integration.repoSetting;
    const value = fieldOf(integrations, integration, key)?.value;
    return typeof value === "string" && REPO_RE.test(value.trim()) ? value.trim() : undefined;
}
// Optional env values alone do not count: the env schema gives them defaults.
export function isAdded(integration) {
    return (integration.configured ||
        integration.fields.some((f) => f.source === "db" || (f.source === "env" && (f.kind === "secret" || f.required))));
}
export const isGithubReady = (integrations) => integrations.find((i) => i.id === "github")?.configured === true;
export const secretsUrl = (repo) => `https://github.com/${repo}/settings/secrets/actions`;
export const actionsSettingsUrl = (repo) => `https://github.com/${repo}/settings/actions`;

import { fieldOf, savedRepo, templateFor } from "./integration-workflows";
export const SERVICE_IDS = ["sentry", "linear", "posthog", "crisp"];
export function neededWorkflows(integrations, templates) {
    return integrations.flatMap((integration) => {
        const template = integration.configured ? templateFor(integration.id, templates) : undefined;
        return template ? [{ integration, template, repo: savedRepo(template, integrations) }] : [];
    });
}
export function stepStatuses(integrations, needed, workflowStates) {
    const token = fieldOf(integrations, "github", "token")?.set === true;
    const repo = fieldOf(integrations, "github", "repo")?.value;
    const services = integrations.some((i) => SERVICE_IDS.some((id) => id === i.id) && i.configured);
    return {
        token: token ? "done" : "todo",
        repository: typeof repo === "string" && repo.length > 0 ? "done" : "todo",
        services: services ? "done" : "todo",
        workflows: needed.length === 0
            ? "idle"
            : needed.every((n) => workflowStates.get(n.template.id) === "installed")
                ? "done"
                : "todo",
    };
}

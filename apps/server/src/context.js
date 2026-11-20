export function createContext({ context, activity, actions, workflows, system, settings, posthog, replay, slackDirectory, adminToken }) {
    const match = /^Bearer\s+(.+)$/i.exec(context.req.header("authorization") ?? "");
    return { activity, actions, workflows, system, settings, posthog, replay, slackDirectory, adminToken, bearer: match?.[1]?.trim() };
}

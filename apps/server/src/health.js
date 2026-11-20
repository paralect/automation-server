export const TOKEN_HEALTH_JOB = "token-health";
const CHECK_HOUR_UTC = 6;
export function createHealthSink({ store, notify }) {
    return {
        async record(project, id, result, now) {
            const previous = store.get(project)[id];
            const current = store.put(project, id, result, now);
            await notify(project, id, previous, current, now);
        },
    };
}
export const createTokenHealthJob = ({ project, integrations, test }) => ({
    name: TOKEN_HEALTH_JOB,
    project,
    due: (now) => (now.getUTCHours() >= CHECK_HOUR_UTC ? now.toISOString().slice(0, 10) : null),
    async run({ now, log }) {
        for (const id of integrations()) {
            const { ok } = await test(id, now);
            log.info("token health checked", { integration: id, ok });
        }
    },
});

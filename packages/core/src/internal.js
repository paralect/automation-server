export const errorMessage = (err) => (err instanceof Error ? err.message : String(err));
export const scopeFields = (name, externalId, project) => project ? { project, automation: name, externalId } : { automation: name, externalId };
export const withFields = (log, fields) => ({
    info: (m, f) => log.info(m, { ...fields, ...f }),
    warn: (m, f) => log.warn(m, { ...fields, ...f }),
    error: (m, f) => log.error(m, { ...fields, ...f }),
});
export const recordActivity = (activity, log, what, scoped, fn) => {
    if (!activity)
        return undefined;
    try {
        return fn(activity);
    }
    catch (err) {
        log.error(`activity ${what} failed`, { ...scoped, error: errorMessage(err) });
        return undefined;
    }
};
export async function drainWithTimeout(inFlight, timeoutMs) {
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([Promise.allSettled([...inFlight]), timeout]);
    clearTimeout(timer);
}
// A handler failure must never turn a finished run into a failed one, so it is logged and dropped.
export async function notifyRunFinished(handler, activity, log, runId, scoped) {
    if (!handler || !activity || !runId)
        return;
    try {
        const run = activity.getRun(runId)?.run;
        if (run && (run.status === "succeeded" || run.status === "failed") && !run.dryRun)
            await handler(run);
    }
    catch (err) {
        log.warn("onRunFinished failed", { ...scoped, runId, error: errorMessage(err) });
    }
}

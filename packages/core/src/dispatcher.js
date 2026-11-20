import { drainWithTimeout, errorMessage, notifyRunFinished, recordActivity, scopeFields, withFields } from "./internal";
import { claimKey } from "./store";
export class ClaimStoreError extends Error {
    cause;
    constructor(cause) {
        super(`claim store failed: ${errorMessage(cause)}`);
        this.cause = cause;
        this.name = "ClaimStoreError";
    }
}
export function createDispatcher({ automations: getAutomations, store, log, prepare, activity, onRunFinished }) {
    const inFlight = new Set();
    const matchesSafely = (automation, event) => {
        try {
            return automation.matches(event);
        }
        catch (err) {
            log.error("matches threw", { automation: automation.name, externalId: event.externalId, error: errorMessage(err) });
            return false;
        }
    };
    const record = (what, scoped, fn) => recordActivity(activity, log, what, scoped, fn);
    // Claims and records the run synchronously so callers can learn the run id before the automation finishes.
    // `original` is the event as received, `event` the one handed to the automation after prepare.
    const begin = (automation, event, original, replayOf, requestedDryRun = false) => {
        const dryRun = requestedDryRun || automation.dryRun === true;
        const key = claimKey(automation.name, event.externalId, automation.project);
        const scoped = scopeFields(automation.name, event.externalId, automation.project);
        const runStart = () => ({
            ...(automation.project ? { project: automation.project } : {}),
            automation: automation.name,
            source: event.source,
            kind: event.kind,
            externalId: event.externalId,
            startedAt: new Date().toISOString(),
            ...(replayOf ? { replayOf } : {}),
            ...(dryRun ? { dryRun } : {}),
        });
        try {
            if (!dryRun && !store.claim(key)) {
                const runId = record("recordDuplicate", scoped, (a) => a.recordDuplicate(runStart()));
                log.info("duplicate skipped", runId ? { ...scoped, runId } : scoped);
                return { status: "duplicate", runId };
            }
        }
        catch (err) {
            log.error("claim failed", { ...scoped, error: errorMessage(err) });
            return { status: "claim-failed", error: err };
        }
        const runId = record("startRun", scoped, (a) => a.startRun({ ...runStart(), event: original }));
        const tagged = runId ? { ...scoped, runId } : scoped;
        const child = withFields(log, tagged);
        let outcome;
        const finish = async (status, error) => {
            if (!runId)
                return;
            record("finishRun", scoped, (a) => a.finishRun(runId, { status, error, finishedAt: new Date().toISOString(), outcome }));
            await notifyRunFinished(onRunFinished, activity, log, runId, scoped);
        };
        const done = (async () => {
            try {
                await automation.run(event, {
                    log: child,
                    ...(dryRun ? { dryRun } : {}),
                    report: (reported) => {
                        outcome = reported;
                    },
                });
            }
            catch (err) {
                if (!dryRun) {
                    try {
                        store.release(key);
                    }
                    catch (releaseErr) {
                        log.error("release failed", { ...scoped, error: errorMessage(releaseErr) });
                    }
                }
                log.error("automation failed", { ...tagged, error: errorMessage(err) });
                await finish("failed", errorMessage(err));
                return;
            }
            if (!dryRun) {
                try {
                    store.complete(key);
                }
                catch (err) {
                    log.error("complete failed", { ...tagged, error: errorMessage(err) });
                }
            }
            await finish("succeeded");
        })();
        return { status: "started", runId, done };
    };
    const track = (work) => {
        inFlight.add(work);
        void work.finally(() => inFlight.delete(work));
    };
    const prepareSafely = async (event) => {
        if (!prepare)
            return event;
        try {
            return await prepare(event);
        }
        catch (err) {
            log.warn("prepare failed, continuing with original event", { project: event.project, externalId: event.externalId, error: errorMessage(err) });
            return event;
        }
    };
    return {
        enqueue(event) {
            const work = prepareSafely(event)
                .then((ready) => Promise.all(getAutomations()
                .filter((a) => a.project === ready.project && matchesSafely(a, ready))
                .map((a) => {
                const started = begin(a, ready, event);
                return started.status === "started" ? started.done : undefined;
            })))
                .then(() => undefined, (err) => log.error("dispatch failed", { project: event.project, externalId: event.externalId, error: errorMessage(err) }));
            track(work);
        },
        async replay({ project, automation: name, event, replayOf, dryRun }) {
            const automation = getAutomations().find((a) => a.name === name && a.project === project);
            if (!automation)
                return { outcome: "unknown-automation" };
            const original = { ...event, project };
            const ready = await prepareSafely(original);
            const started = begin(automation, ready, original, replayOf, dryRun);
            if (started.status === "claim-failed")
                throw new ClaimStoreError(started.error);
            if (started.status === "duplicate")
                return { outcome: "duplicate", ...(started.runId ? { runId: started.runId } : {}) };
            track(started.done);
            return { outcome: "started", ...(started.runId ? { runId: started.runId } : {}) };
        },
        drain: (timeoutMs) => drainWithTimeout(inFlight, timeoutMs),
    };
}

import { drainWithTimeout, errorMessage, notifyRunFinished, recordActivity, scopeFields, withFields } from "./internal";
import { claimKey } from "./store";
export const SCHEDULE_SOURCE = "schedule";
export function createScheduler({ jobs, store, log, activity, onRunFinished, now = () => new Date(), tickMs = 60_000 }) {
    const running = new Set();
    const inFlight = new Set();
    let timer;
    const record = (what, scoped, fn) => recordActivity(activity, log, what, scoped, fn);
    const execute = async (job, key, at, options = {}) => {
        const claim = claimKey(job.name, key, job.project);
        const scoped = scopeFields(job.name, key, job.project);
        try {
            if (!store.claim(claim))
                return { status: "duplicate" };
        }
        catch (err) {
            log.error("claim failed", { ...scoped, error: errorMessage(err) });
            return { status: "duplicate" };
        }
        const runId = record("startRun", scoped, (a) => a.startRun({
            ...(job.project ? { project: job.project } : {}),
            automation: job.name,
            source: SCHEDULE_SOURCE,
            kind: "job",
            externalId: key,
            startedAt: at.toISOString(),
            ...(options.replayOf ? { replayOf: options.replayOf } : {}),
        }));
        options.onStarted?.(runId ?? null);
        const tagged = runId ? { ...scoped, source: SCHEDULE_SOURCE, runId } : { ...scoped, source: SCHEDULE_SOURCE };
        const child = withFields(log, tagged);
        const finish = async (status, error) => {
            if (!runId)
                return;
            record("finishRun", scoped, (a) => a.finishRun(runId, { status, error, finishedAt: now().toISOString() }));
            await notifyRunFinished(onRunFinished, activity, log, runId, scoped);
        };
        let error;
        try {
            await job.run({ log: child, key, now: at });
        }
        catch (err) {
            error = errorMessage(err);
        }
        // A failed run keeps its claim too, so a broken integration is not retried every tick; runNow with a fresh key is the retry.
        try {
            store.complete(claim);
        }
        catch (err) {
            log.error("complete failed", { ...tagged, error: errorMessage(err) });
        }
        if (error !== undefined) {
            log.error("job failed", { ...tagged, error });
            await finish("failed", error);
            return { status: "failed", runId: runId ?? null, error };
        }
        await finish("succeeded");
        return { status: "succeeded", runId: runId ?? null };
    };
    const guarded = async (job, key, at, options) => {
        const slot = claimKey(job.name, "", job.project);
        if (running.has(slot))
            return { status: "busy" };
        running.add(slot);
        const work = execute(job, key, at, options);
        inFlight.add(work);
        try {
            return await work;
        }
        finally {
            running.delete(slot);
            inFlight.delete(work);
        }
    };
    const tick = async () => {
        const at = now();
        let current;
        try {
            current = jobs();
        }
        catch (err) {
            log.error("job list failed", { error: errorMessage(err) });
            return;
        }
        const started = [];
        for (const job of current) {
            let key;
            try {
                key = job.due(at);
            }
            catch (err) {
                log.error("job due check failed", { project: job.project, automation: job.name, error: errorMessage(err) });
                continue;
            }
            if (key !== null)
                started.push(guarded(job, key, at));
        }
        await Promise.allSettled(started);
    };
    return {
        start() {
            if (timer)
                return;
            timer = setInterval(() => void tick(), tickMs);
            timer.unref();
            void tick();
        },
        stop() {
            if (timer)
                clearInterval(timer);
            timer = undefined;
        },
        tick,
        async runNow(target, key, options) {
            const job = typeof target === "string" ? jobs().find((j) => j.name === target) : target;
            if (!job)
                return { status: "unknown-job" };
            return guarded(job, key, now(), options);
        },
        drain: (timeoutMs) => drainWithTimeout(inFlight, timeoutMs),
    };
}

import type { ActivityStore } from "./activity";
import type { Job } from "./job";
import type { Logger } from "./logger";
import { drainWithTimeout, errorMessage, notifyRunFinished, recordActivity, scopeFields, withFields, type RunFinishedHandler } from "./internal";
import { claimKey, type ClaimStore } from "./store";

export const SCHEDULE_SOURCE = "schedule";

export type RunNowResult =
  | { readonly status: "succeeded"; readonly runId: string | null }
  | { readonly status: "failed"; readonly runId: string | null; readonly error: string }
  | { readonly status: "duplicate" | "busy" | "unknown-job" };

export type RunNowOptions = {
  readonly replayOf?: string;
  // Called once the run row exists, before the job finishes, so a caller with a request timeout can answer early.
  readonly onStarted?: (runId: string | null) => void;
};

export type Scheduler = {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
  runNow(job: string | Job, key: string, options?: RunNowOptions): Promise<RunNowResult>;
  drain(timeoutMs: number): Promise<void>;
};

export type SchedulerDeps = {
  jobs: () => readonly Job[];
  store: ClaimStore;
  log: Logger;
  activity?: ActivityStore;
  // Called after a job run succeeded or failed. drain() waits for it.
  onRunFinished?: RunFinishedHandler;
  now?: () => Date;
  tickMs?: number;
};

export function createScheduler({ jobs, store, log, activity, onRunFinished, now = () => new Date(), tickMs = 60_000 }: SchedulerDeps): Scheduler {
  const running = new Set<string>();
  const inFlight = new Set<Promise<unknown>>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const record = <T>(what: string, scoped: Record<string, string>, fn: (activity: ActivityStore) => T) =>
    recordActivity(activity, log, what, scoped, fn);

  const execute = async (job: Job, key: string, at: Date, options: RunNowOptions = {}): Promise<RunNowResult> => {
    const claim = claimKey(job.name, key, job.project);
    const scoped = scopeFields(job.name, key, job.project);
    try {
      if (!store.claim(claim)) return { status: "duplicate" };
    } catch (err) {
      log.error("claim failed", { ...scoped, error: errorMessage(err) });
      return { status: "duplicate" };
    }
    const runId = record("startRun", scoped, (a) =>
      a.startRun({
        ...(job.project ? { project: job.project } : {}),
        automation: job.name,
        source: SCHEDULE_SOURCE,
        kind: "job",
        externalId: key,
        startedAt: at.toISOString(),
        ...(options.replayOf ? { replayOf: options.replayOf } : {}),
      }),
    );
    options.onStarted?.(runId ?? null);
    const tagged = runId ? { ...scoped, source: SCHEDULE_SOURCE, runId } : { ...scoped, source: SCHEDULE_SOURCE };
    const child = withFields(log, tagged);
    const finish = async (status: "succeeded" | "failed", error?: string) => {
      if (!runId) return;
      record("finishRun", scoped, (a) => a.finishRun(runId, { status, error, finishedAt: now().toISOString() }));
      await notifyRunFinished(onRunFinished, activity, log, runId, scoped);
    };
    let error: string | undefined;
    try {
      await job.run({ log: child, key, now: at });
    } catch (err) {
      error = errorMessage(err);
    }
    // A failed run keeps its claim too, so a broken integration is not retried every tick; runNow with a fresh key is the retry.
    try {
      store.complete(claim);
    } catch (err) {
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

  const guarded = async (job: Job, key: string, at: Date, options?: RunNowOptions): Promise<RunNowResult> => {
    const slot = claimKey(job.name, "", job.project);
    if (running.has(slot)) return { status: "busy" };
    running.add(slot);
    const work = execute(job, key, at, options);
    inFlight.add(work);
    try {
      return await work;
    } finally {
      running.delete(slot);
      inFlight.delete(work);
    }
  };

  const tick = async () => {
    const at = now();
    let current: readonly Job[];
    try {
      current = jobs();
    } catch (err) {
      log.error("job list failed", { error: errorMessage(err) });
      return;
    }
    const started: Promise<unknown>[] = [];
    for (const job of current) {
      let key: string | null;
      try {
        key = job.due(at);
      } catch (err) {
        log.error("job due check failed", { project: job.project, automation: job.name, error: errorMessage(err) });
        continue;
      }
      if (key !== null) started.push(guarded(job, key, at));
    }
    await Promise.allSettled(started);
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), tickMs);
      timer.unref();
      void tick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    tick,
    async runNow(target, key, options) {
      const job = typeof target === "string" ? jobs().find((j) => j.name === target) : target;
      if (!job) return { status: "unknown-job" };
      return guarded(job, key, now(), options);
    },
    drain: (timeoutMs) => drainWithTimeout(inFlight, timeoutMs),
  };
}

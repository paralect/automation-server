import type { ActivityStore } from "./activity";
import type { Job } from "./job";
import type { Logger } from "./logger";
import { claimKey, type ClaimStore } from "./store";

export const SCHEDULE_SOURCE = "schedule";

export type RunNowResult =
  | { readonly status: "succeeded"; readonly runId: string | null }
  | { readonly status: "failed"; readonly runId: string | null; readonly error: string }
  | { readonly status: "duplicate" | "busy" | "unknown-job" };

export type Scheduler = {
  start(): void;
  stop(): void;
  /** Checks every job once. Resolves when the jobs it started have finished. */
  tick(): Promise<void>;
  /**
   * Runs a job now under an explicit claim key, bypassing `due`. Recorded like a scheduled run.
   * A job object runs even when it is not in `jobs()`, so an admin can trigger a job that is disabled on the schedule.
   */
  runNow(job: string | Job, key: string): Promise<RunNowResult>;
  drain(timeoutMs: number): Promise<void>;
};

export type SchedulerDeps = {
  jobs: () => readonly Job[];
  store: ClaimStore;
  log: Logger;
  activity?: ActivityStore;
  now?: () => Date;
  tickMs?: number;
};

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createScheduler({ jobs, store, log, activity, now = () => new Date(), tickMs = 60_000 }: SchedulerDeps): Scheduler {
  const running = new Set<string>();
  const inFlight = new Set<Promise<unknown>>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const record = <T>(what: string, scoped: Record<string, string>, fn: (activity: ActivityStore) => T): T | undefined => {
    if (!activity) return undefined;
    try {
      return fn(activity);
    } catch (err) {
      log.error(`activity ${what} failed`, { ...scoped, error: errorMessage(err) });
      return undefined;
    }
  };

  /**
   * A failed run keeps its claim. Retrying every tick would hammer a broken integration once a minute,
   * so a failed occurrence is not retried automatically. `runNow` with a fresh key is the retry.
   */
  const execute = async (job: Job, key: string, at: Date): Promise<RunNowResult> => {
    const claim = claimKey(job.name, key);
    const scoped = { automation: job.name, externalId: key };
    try {
      if (!store.claim(claim)) return { status: "duplicate" };
    } catch (err) {
      log.error("claim failed", { ...scoped, error: errorMessage(err) });
      return { status: "duplicate" };
    }
    const runId = record("startRun", scoped, (a) =>
      a.startRun({ automation: job.name, source: SCHEDULE_SOURCE, kind: "job", externalId: key, startedAt: at.toISOString() }),
    );
    const tagged = runId ? { ...scoped, source: SCHEDULE_SOURCE, runId } : { ...scoped, source: SCHEDULE_SOURCE };
    const child: Logger = {
      info: (m, f) => log.info(m, { ...tagged, ...f }),
      warn: (m, f) => log.warn(m, { ...tagged, ...f }),
      error: (m, f) => log.error(m, { ...tagged, ...f }),
    };
    const finish = (status: "succeeded" | "failed", error?: string) => {
      if (runId) record("finishRun", scoped, (a) => a.finishRun(runId, { status, error, finishedAt: now().toISOString() }));
    };
    try {
      await job.run({ log: child, key, now: at });
      store.complete(claim);
      finish("succeeded");
      return { status: "succeeded", runId: runId ?? null };
    } catch (err) {
      store.complete(claim);
      log.error("job failed", { ...tagged, error: errorMessage(err) });
      finish("failed", errorMessage(err));
      return { status: "failed", runId: runId ?? null, error: errorMessage(err) };
    }
  };

  const guarded = async (job: Job, key: string, at: Date): Promise<RunNowResult> => {
    if (running.has(job.name)) return { status: "busy" };
    running.add(job.name);
    const work = execute(job, key, at);
    inFlight.add(work);
    try {
      return await work;
    } finally {
      running.delete(job.name);
      inFlight.delete(work);
    }
  };

  const tick = async () => {
    const at = now();
    const started: Promise<unknown>[] = [];
    for (const job of jobs()) {
      let key: string | null;
      try {
        key = job.due(at);
      } catch (err) {
        log.error("job due check failed", { automation: job.name, error: errorMessage(err) });
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
    async runNow(target, key) {
      const job = typeof target === "string" ? jobs().find((j) => j.name === target) : target;
      if (!job) return { status: "unknown-job" };
      return guarded(job, key, now());
    },
    async drain(timeoutMs) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      });
      await Promise.race([Promise.allSettled([...inFlight]), limit]);
      clearTimeout(timeout);
    },
  };
}

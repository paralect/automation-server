import type { ActivityStore, RunRecord } from "./activity";
import type { Logger } from "./logger";

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const scopeFields = (name: string, externalId: string, project?: string): Record<string, string> =>
  project ? { project, automation: name, externalId } : { automation: name, externalId };

export const withFields = (log: Logger, fields: Record<string, unknown>): Logger => ({
  info: (m, f) => log.info(m, { ...fields, ...f }),
  warn: (m, f) => log.warn(m, { ...fields, ...f }),
  error: (m, f) => log.error(m, { ...fields, ...f }),
});

export const recordActivity = <T>(
  activity: ActivityStore | undefined,
  log: Logger,
  what: string,
  scoped: Record<string, string>,
  fn: (activity: ActivityStore) => T,
): T | undefined => {
  if (!activity) return undefined;
  try {
    return fn(activity);
  } catch (err) {
    log.error(`activity ${what} failed`, { ...scoped, error: errorMessage(err) });
    return undefined;
  }
};

export async function drainWithTimeout(inFlight: Iterable<Promise<unknown>>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([Promise.allSettled([...inFlight]), timeout]);
  clearTimeout(timer);
}

export type RunFinishedHandler = (run: RunRecord) => void | Promise<void>;

// A handler failure must never turn a finished run into a failed one, so it is logged and dropped.
export async function notifyRunFinished(
  handler: RunFinishedHandler | undefined,
  activity: ActivityStore | undefined,
  log: Logger,
  runId: string | undefined,
  scoped: Record<string, string>,
): Promise<void> {
  if (!handler || !activity || !runId) return;
  try {
    const run = activity.getRun(runId)?.run;
    if (run && (run.status === "succeeded" || run.status === "failed") && !run.dryRun) await handler(run);
  } catch (err) {
    log.warn("onRunFinished failed", { ...scoped, runId, error: errorMessage(err) });
  }
}

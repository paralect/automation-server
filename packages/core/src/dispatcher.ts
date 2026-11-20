import type { ActivityStore, RunOutcome } from "./activity";
import type { Automation } from "./automation";
import type { Event } from "./event";
import type { Logger } from "./logger";
import { drainWithTimeout, errorMessage, notifyRunFinished, recordActivity, scopeFields, withFields, type RunFinishedHandler } from "./internal";
import { runInScope } from "./runScope";
import { claimKey, type ClaimStore } from "./store";

export class ClaimStoreError extends Error {
  constructor(readonly cause: unknown) {
    super(`claim store failed: ${errorMessage(cause)}`);
    this.name = "ClaimStoreError";
  }
}

export type ReplayRequest = {
  readonly project: string;
  readonly automation: string;
  readonly event: Event;
  readonly replayOf: string;
  readonly dryRun?: boolean;
};

export type ReplayResult = {
  readonly runId?: string;
  readonly outcome: "started" | "duplicate" | "unknown-automation";
};

export type Dispatcher = {
  enqueue(event: Event): void;
  // A dry run never touches the claim store: it writes nothing, so exactly-once does not apply, and the original run's claim (possibly `done`) must survive it.
  // Skips `matches` on purpose: the event may no longer match the automation. Resolves once the run row exists, not when the automation finishes.
  replay(request: ReplayRequest): Promise<ReplayResult>;
  drain(timeoutMs: number): Promise<void>;
};

export type DispatcherDeps = {
  automations: () => readonly Automation[];
  store: ClaimStore;
  log: Logger;
  prepare?: (event: Event) => Promise<Event>;
  activity?: ActivityStore;
  // Called after a real run succeeded or failed, never for duplicates or dry runs. drain() waits for it.
  onRunFinished?: RunFinishedHandler;
};

export function createDispatcher({ automations: getAutomations, store, log, prepare, activity, onRunFinished }: DispatcherDeps): Dispatcher {
  const inFlight = new Set<Promise<unknown>>();

  const matchesSafely = (automation: Automation, event: Event): boolean => {
    try {
      return automation.matches(event);
    } catch (err) {
      log.error("matches threw", { automation: automation.name, externalId: event.externalId, error: errorMessage(err) });
      return false;
    }
  };

  const record = <T>(what: string, scoped: Record<string, string>, fn: (activity: ActivityStore) => T) =>
    recordActivity(activity, log, what, scoped, fn);

  type Started =
    | { readonly status: "started"; readonly runId: string | undefined; readonly done: Promise<void> }
    | { readonly status: "duplicate"; readonly runId: string | undefined }
    | { readonly status: "claim-failed"; readonly error: unknown };

  // Claims and records the run synchronously so callers can learn the run id before the automation finishes.
  // `original` is the event as received, `event` the one handed to the automation after prepare.
  const begin = (automation: Automation, event: Event, original: Event, replayOf?: string, requestedDryRun = false): Started => {
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
    } catch (err) {
      log.error("claim failed", { ...scoped, error: errorMessage(err) });
      return { status: "claim-failed", error: err };
    }
    const runId = record("startRun", scoped, (a) => a.startRun({ ...runStart(), event: original }));
    const tagged = runId ? { ...scoped, runId } : scoped;
    const child = withFields(log, tagged);
    let outcome: RunOutcome | undefined;
    const finish = async (status: "succeeded" | "failed", error?: string) => {
      if (!runId) return;
      record("finishRun", scoped, (a) => a.finishRun(runId, { status, error, finishedAt: new Date().toISOString(), outcome }));
      await notifyRunFinished(onRunFinished, activity, log, runId, scoped);
    };
    const done = (async () => {
      try {
        await runInScope({ runId: runId ?? null, project: automation.project, automation: automation.name, dryRun }, () =>
          automation.run(event, {
            log: child,
            ...(dryRun ? { dryRun } : {}),
            report: (reported) => {
              outcome = reported;
            },
          }),
        );
      } catch (err) {
        if (!dryRun) {
          try {
            store.release(key);
          } catch (releaseErr) {
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
        } catch (err) {
          log.error("complete failed", { ...tagged, error: errorMessage(err) });
        }
      }
      await finish("succeeded");
    })();
    return { status: "started", runId, done };
  };

  const track = (work: Promise<unknown>) => {
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  };

  const prepareSafely = async (event: Event): Promise<Event> => {
    if (!prepare) return event;
    try {
      return await prepare(event);
    } catch (err) {
      log.warn("prepare failed, continuing with original event", { project: event.project, externalId: event.externalId, error: errorMessage(err) });
      return event;
    }
  };

  return {
    enqueue(event) {
      const work = prepareSafely(event)
        .then((ready) =>
          Promise.all(
            getAutomations()
              .filter((a) => a.project === ready.project && matchesSafely(a, ready))
              .map((a) => {
                const started = begin(a, ready, event);
                return started.status === "started" ? started.done : undefined;
              }),
          ),
        )
        .then(
          () => undefined,
          (err: unknown) => log.error("dispatch failed", { project: event.project, externalId: event.externalId, error: errorMessage(err) }),
        );
      track(work);
    },
    async replay({ project, automation: name, event, replayOf, dryRun }) {
      const automation = getAutomations().find((a) => a.name === name && a.project === project);
      if (!automation) return { outcome: "unknown-automation" };
      const original = { ...event, project };
      const ready = await prepareSafely(original);
      const started = begin(automation, ready, original, replayOf, dryRun);
      if (started.status === "claim-failed") throw new ClaimStoreError(started.error);
      if (started.status === "duplicate") return { outcome: "duplicate", ...(started.runId ? { runId: started.runId } : {}) };
      track(started.done);
      return { outcome: "started", ...(started.runId ? { runId: started.runId } : {}) };
    },
    drain: (timeoutMs) => drainWithTimeout(inFlight, timeoutMs),
  };
}

import type { ActivityStore, RunOutcome } from "./activity";
import type { Automation } from "./automation";
import type { Event } from "./event";
import type { Logger } from "./logger";
import { drainWithTimeout, errorMessage, recordActivity, scopeFields, withFields } from "./internal";
import { claimKey, type ClaimStore } from "./store";

export type Dispatcher = {
  enqueue(event: Event): void;
  drain(timeoutMs: number): Promise<void>;
};

export type DispatcherDeps = {
  automations: () => readonly Automation[];
  store: ClaimStore;
  log: Logger;
  prepare?: (event: Event) => Promise<Event>;
  activity?: ActivityStore;
};

export function createDispatcher({ automations: getAutomations, store, log, prepare, activity }: DispatcherDeps): Dispatcher {
  const inFlight = new Set<Promise<void>>();

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

  const runOne = async (automation: Automation, event: Event): Promise<void> => {
    const key = claimKey(automation.name, event.externalId, automation.project);
    const scoped = scopeFields(automation.name, event.externalId, automation.project);
    const runStart = () => ({
      ...(automation.project ? { project: automation.project } : {}),
      automation: automation.name,
      source: event.source,
      kind: event.kind,
      externalId: event.externalId,
      startedAt: new Date().toISOString(),
    });
    try {
      if (!store.claim(key)) {
        const runId = record("recordDuplicate", scoped, (a) => a.recordDuplicate(runStart()));
        log.info("duplicate skipped", runId ? { ...scoped, runId } : scoped);
        return;
      }
    } catch (err) {
      log.error("claim failed", { ...scoped, error: errorMessage(err) });
      return;
    }
    const runId = record("startRun", scoped, (a) => a.startRun(runStart()));
    const tagged = runId ? { ...scoped, runId } : scoped;
    const child = withFields(log, tagged);
    let outcome: RunOutcome | undefined;
    const finish = (status: "succeeded" | "failed", error?: string) => {
      if (runId) record("finishRun", scoped, (a) => a.finishRun(runId, { status, error, finishedAt: new Date().toISOString(), outcome }));
    };
    try {
      await automation.run(event, {
        log: child,
        report: (reported) => {
          outcome = reported;
        },
      });
    } catch (err) {
      try {
        store.release(key);
      } catch (releaseErr) {
        log.error("release failed", { ...scoped, error: errorMessage(releaseErr) });
      }
      log.error("automation failed", { ...tagged, error: errorMessage(err) });
      finish("failed", errorMessage(err));
      return;
    }
    try {
      store.complete(key);
    } catch (err) {
      log.error("complete failed", { ...tagged, error: errorMessage(err) });
    }
    finish("succeeded");
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
              .map((a) => runOne(a, ready)),
          ),
        )
        .then(
          () => undefined,
          (err: unknown) => log.error("dispatch failed", { project: event.project, externalId: event.externalId, error: errorMessage(err) }),
        );
      inFlight.add(work);
      void work.finally(() => inFlight.delete(work));
    },
    drain: (timeoutMs) => drainWithTimeout(inFlight, timeoutMs),
  };
}

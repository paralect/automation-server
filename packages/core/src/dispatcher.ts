import type { ActivityStore } from "./activity";
import type { Automation } from "./automation";
import type { Event } from "./event";
import type { Logger } from "./logger";
import { claimKey, type ClaimStore } from "./store";

export type Dispatcher = {
  enqueue(event: Event): void;
  drain(timeoutMs: number): Promise<void>;
};

export type DispatcherDeps = {
  /** Read once per event, so a live reload takes effect for the next event and never splits one event across two lists. */
  automations: () => readonly Automation[];
  store: ClaimStore;
  log: Logger;
  prepare?: (event: Event) => Promise<Event>;
  activity?: ActivityStore;
};

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

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

  const record = <T>(what: string, scoped: Record<string, string>, fn: (activity: ActivityStore) => T): T | undefined => {
    if (!activity) return undefined;
    try {
      return fn(activity);
    } catch (err) {
      log.error(`activity ${what} failed`, { ...scoped, error: errorMessage(err) });
      return undefined;
    }
  };

  const runOne = async (automation: Automation, event: Event): Promise<void> => {
    const key = claimKey(automation.name, event.externalId, automation.project);
    const scoped: Record<string, string> = automation.project
      ? { project: automation.project, automation: automation.name, externalId: event.externalId }
      : { automation: automation.name, externalId: event.externalId };
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
    const child: Logger = {
      info: (m, f) => log.info(m, { ...tagged, ...f }),
      warn: (m, f) => log.warn(m, { ...tagged, ...f }),
      error: (m, f) => log.error(m, { ...tagged, ...f }),
    };
    const finish = (status: "succeeded" | "failed", error?: string) => {
      if (runId) record("finishRun", scoped, (a) => a.finishRun(runId, { status, error, finishedAt: new Date().toISOString() }));
    };
    try {
      await automation.run(event, { log: child });
      store.complete(key);
      finish("succeeded");
    } catch (err) {
      try {
        store.release(key);
      } catch (releaseErr) {
        log.error("release failed", { ...scoped, error: errorMessage(releaseErr) });
      }
      log.error("automation failed", { ...tagged, error: errorMessage(err) });
      finish("failed", errorMessage(err));
    }
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
        .then(() => undefined);
      inFlight.add(work);
      void work.finally(() => inFlight.delete(work));
    },
    async drain(timeoutMs) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      });
      await Promise.race([Promise.allSettled([...inFlight]), timeout]);
      clearTimeout(timer);
    },
  };
}

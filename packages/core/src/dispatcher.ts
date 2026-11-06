import type { Automation } from "./automation";
import type { Event } from "./event";
import type { Logger } from "./logger";
import { claimKey, type ClaimStore } from "./store";

export type Dispatcher = {
  enqueue(event: Event): void;
  drain(timeoutMs: number): Promise<void>;
};

export type DispatcherDeps = {
  automations: readonly Automation[];
  store: ClaimStore;
  log: Logger;
  prepare?: (event: Event) => Promise<Event>;
};

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createDispatcher({ automations, store, log, prepare }: DispatcherDeps): Dispatcher {
  const inFlight = new Set<Promise<void>>();

  const matchesSafely = (automation: Automation, event: Event): boolean => {
    try {
      return automation.matches(event);
    } catch (err) {
      log.error("matches threw", { automation: automation.name, externalId: event.externalId, error: errorMessage(err) });
      return false;
    }
  };

  const runOne = async (automation: Automation, event: Event): Promise<void> => {
    const key = claimKey(automation.name, event.externalId);
    const scoped = { automation: automation.name, externalId: event.externalId };
    try {
      if (!store.claim(key)) {
        log.info("duplicate skipped", scoped);
        return;
      }
    } catch (err) {
      log.error("claim failed", { ...scoped, error: errorMessage(err) });
      return;
    }
    const child: Logger = {
      info: (m, f) => log.info(m, { ...scoped, ...f }),
      warn: (m, f) => log.warn(m, { ...scoped, ...f }),
      error: (m, f) => log.error(m, { ...scoped, ...f }),
    };
    try {
      await automation.run(event, { log: child });
      store.complete(key);
    } catch (err) {
      try {
        store.release(key);
      } catch (releaseErr) {
        log.error("release failed", { ...scoped, error: errorMessage(releaseErr) });
      }
      log.error("automation failed", { ...scoped, error: errorMessage(err) });
    }
  };

  const prepareSafely = async (event: Event): Promise<Event> => {
    if (!prepare) return event;
    try {
      return await prepare(event);
    } catch (err) {
      log.warn("prepare failed, continuing with original event", { externalId: event.externalId, error: errorMessage(err) });
      return event;
    }
  };

  return {
    enqueue(event) {
      const work = prepareSafely(event)
        .then((ready) =>
          Promise.all(automations.filter((a) => matchesSafely(a, ready)).map((a) => runOne(a, ready))),
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

import { AsyncLocalStorage } from "node:async_hooks";

// Which run's code is on the current async stack. Service-agnostic: core knows runs, not what a run calls.
export type RunScope = {
  // null when the activity store failed to record the run. What it does still counts for the project.
  readonly runId: string | null;
  readonly project: string | undefined;
  readonly automation: string;
  readonly dryRun: boolean;
};

const storage = new AsyncLocalStorage<RunScope>();

// Read by observers that clients built once per module report through. Automations get their run through ctx instead.
export function currentRun(): RunScope | undefined {
  return storage.getStore();
}

// Only the dispatcher and the scheduler open a scope, so the index does not export it.
export function runInScope<T>(scope: RunScope, fn: () => T): T {
  return storage.run(scope, fn);
}

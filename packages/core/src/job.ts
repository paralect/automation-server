import type { Logger } from "./logger";

export type JobContext = {
  readonly log: Logger;
  /** The claim key this run was started under, the one `due` returned or the one passed to `runNow`. */
  readonly key: string;
  readonly now: Date;
};

export type Job = {
  readonly name: string;
  /**
   * Called on every tick. Returns the claim key of the occurrence that is due now, or null.
   * The key must be stable for the whole occurrence (for example `2026-W07`), because the
   * scheduler runs each (job name, key) pair at most once.
   */
  due(now: Date): string | null;
  run(ctx: JobContext): Promise<void>;
};

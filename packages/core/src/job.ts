import type { Logger } from "./logger";

export type JobContext = {
  readonly log: Logger;
  readonly key: string;
  readonly now: Date;
};

export type Job = {
  readonly name: string;
  readonly project?: string;
  due(now: Date): string | null;
  run(ctx: JobContext): Promise<void>;
};

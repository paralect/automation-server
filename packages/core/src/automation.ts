import type { RunOutcome } from "./activity";
import type { Event } from "./event";
import type { Logger } from "./logger";

export type AutomationContext = {
  readonly log: Logger;
  // Reads stay, writes are skipped. The automation says what it would have done through ctx.log and report.
  readonly dryRun?: boolean;
  report?(outcome: RunOutcome): void;
};

export type Automation = {
  readonly name: string;
  readonly project?: string;
  matches(event: Event): boolean;
  run(event: Event, ctx: AutomationContext): Promise<void>;
};

export function defineAutomation<E extends Event>(spec: {
  name: string;
  matches: (event: Event) => event is E;
  run: (event: E, ctx: AutomationContext) => Promise<void>;
}): Automation {
  return {
    name: spec.name,
    matches: spec.matches,
    run: (event, ctx) => spec.run(event as E, ctx),
  };
}

import type { Event } from "./event";
import type { Logger } from "./logger";

export type AutomationContext = {
  readonly log: Logger;
};

export type Automation = {
  readonly name: string;
  /** Only events of this project reach the automation. Its claims and runs are scoped to it too. */
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

import type { Automation, Job, Logger, Source } from "@automation-server/core";
import type { ConnectionTestResult, IntegrationId, ResolvedConfig } from "@automation-server/settings";

export type ModuleDeps = {
  readonly log: Logger;
  readonly fetch?: typeof fetch;
};

export type ModuleOutput = {
  sources?: Source[];
  automations?: Automation[];
  jobs?: Job[];
};

export type IntegrationModule<I extends IntegrationId = IntegrationId> = {
  readonly id: I;
  build(config: ResolvedConfig, deps: ModuleDeps): ModuleOutput;
  // The scheduled token check skips a module whose test writes to the outside world, like posting a Slack message.
  readonly testHasSideEffects?: true;
  test?(config: ResolvedConfig, deps: ModuleDeps): Promise<ConnectionTestResult>;
};

export const defineModule = <I extends IntegrationId>(module: IntegrationModule<I>): IntegrationModule<I> => module;

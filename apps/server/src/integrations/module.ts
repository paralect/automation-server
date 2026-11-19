import type { Automation, Job, Logger, Source } from "@automation-server/core";
import type { ConnectionTestResult, IntegrationId, ResolvedConfig } from "@automation-server/settings";

export type ModuleDeps = {
  readonly log: Logger;
  readonly fetch?: typeof fetch;
};

export type TestOptions = { readonly scheduled?: boolean };

export type ModuleOutput = {
  sources?: Source[];
  automations?: Automation[];
  jobs?: Job[];
};

export type IntegrationModule<I extends IntegrationId = IntegrationId> = {
  readonly id: I;
  build(config: ResolvedConfig, deps: ModuleDeps): ModuleOutput;
  // Whether the daily token check should run this module's test under this configuration. Default is yes.
  readonly scheduledCheck?: (config: ResolvedConfig) => boolean;
  // A scheduled call must stay read-only. A module whose test writes to the outside world, like posting a Slack message, skips that part when `scheduled` is set.
  test?(config: ResolvedConfig, deps: ModuleDeps, options?: TestOptions): Promise<ConnectionTestResult>;
};

export const defineModule = <I extends IntegrationId>(module: IntegrationModule<I>): IntegrationModule<I> => module;

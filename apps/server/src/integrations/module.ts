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

/**
 * One integration's runtime pieces. `build` runs on boot and after every settings change, only while
 * `config[id].configured` is true, and receives every integration's resolved config so a module can
 * depend on another one (for example Linear needs the GitHub token). Return the sources, automations
 * and jobs to register. Return fewer, or nothing, when a dependency is missing, and log why.
 */
export type IntegrationModule<I extends IntegrationId = IntegrationId> = {
  readonly id: I;
  build(config: ResolvedConfig, deps: ModuleDeps): ModuleOutput;
  /** Backs `settings.testConnection`. Runs only while the integration is configured. */
  test?(config: ResolvedConfig, deps: ModuleDeps): Promise<ConnectionTestResult>;
};

export const defineModule = <I extends IntegrationId>(module: IntegrationModule<I>): IntegrationModule<I> => module;

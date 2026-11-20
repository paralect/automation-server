import type { Automation, Job, Logger, PendingActionStore, Source } from "@automation-server/core";
import type { LedgerSyncPort, Observer } from "@automation-server/ledger";
import type { ConnectionTestResult, IntegrationId, ResolvedConfig } from "@automation-server/settings";

export type ModuleDeps = {
  readonly log: Logger;
  readonly fetch?: typeof fetch;
  // The project being built. Set by the runtime for every module.
  readonly project?: string;
  // Where proposed writes wait for approval. Without it the Slack bot offers no write tools.
  readonly pending?: PendingActionStore;
  // The project's observer. Every LLM and GitHub client a module builds reports through it.
  readonly observe: Observer;
  // Where the outcome sync writes Codex PRs and workflow runs. Without it the GitHub module builds no sync job.
  readonly ledger?: LedgerSyncPort;
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

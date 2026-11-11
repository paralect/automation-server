import type { Automation, Job, Source } from "@automation-server/core";
import { INTEGRATIONS, type ConnectionTestResult, type IntegrationId, type ResolvedConfig } from "@automation-server/settings";

import type { IntegrationModule, ModuleDeps } from "./integrations/module";

type Snapshot = {
  readonly sources: Readonly<Record<string, Source>>;
  readonly automations: readonly Automation[];
  readonly jobs: readonly Job[];
};

export type Runtime = {
  sources(): Readonly<Record<string, Source>>;
  automations(): readonly Automation[];
  jobs(): readonly Job[];
  /** Re-resolves settings and swaps the registered sources, automations and jobs in one step. */
  rebuild(): void;
  test(id: IntegrationId): Promise<ConnectionTestResult>;
};

export type RuntimeDeps = {
  modules: readonly IntegrationModule[];
  resolve: () => ResolvedConfig;
  deps: ModuleDeps;
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createRuntime({ modules, resolve, deps }: RuntimeDeps): Runtime {
  const { log } = deps;

  const build = (config: ResolvedConfig): Snapshot => {
    const sources: Record<string, Source> = {};
    const automations: Automation[] = [];
    const jobs: Job[] = [];
    for (const module of modules) {
      if (!config[module.id].configured) continue;
      try {
        const out = module.build(config, deps);
        for (const source of out.sources ?? []) {
          if (Object.hasOwn(sources, source.name)) {
            log.error("duplicate source name, skipped", { integration: module.id, source: source.name });
            continue;
          }
          sources[source.name] = source;
        }
        automations.push(...(out.automations ?? []));
        jobs.push(...(out.jobs ?? []));
      } catch (err) {
        log.error("integration build failed, skipped", { integration: module.id, error: message(err) });
      }
    }
    return { sources, automations, jobs };
  };

  let current: Snapshot = build(resolve());

  return {
    sources: () => current.sources,
    automations: () => current.automations,
    jobs: () => current.jobs,
    rebuild() {
      current = build(resolve());
      log.info("integrations reloaded", {
        sources: Object.keys(current.sources),
        automations: current.automations.map((a) => a.name),
        jobs: current.jobs.map((j) => j.name),
      });
    },
    async test(id) {
      const title = INTEGRATIONS[id].title;
      const module = modules.find((m) => m.id === id);
      if (!module?.test) return { ok: false, available: false, message: `Connection test is not available for ${title} yet` };
      const config = resolve();
      const resolved = config[id];
      if (!resolved.configured) {
        return { ok: false, available: true, message: `${title} is not configured. Missing: ${resolved.missing.join(", ")}` };
      }
      try {
        return await module.test(config, deps);
      } catch (err) {
        return { ok: false, available: true, message: `Connection test failed: ${message(err)}` };
      }
    },
  };
}

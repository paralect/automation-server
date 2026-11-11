import type { Automation, Job, Logger, Source } from "@automation-server/core";
import { INTEGRATIONS, type ConnectionTestResult, type IntegrationId, type ResolvedConfig } from "@automation-server/settings";

import type { IntegrationModule, ModuleDeps } from "./integrations/module";

type ProjectSnapshot = {
  readonly sources: Readonly<Record<string, Source>>;
  readonly automations: readonly Automation[];
  readonly jobs: readonly Job[];
};

type Snapshot = {
  readonly projects: ReadonlyMap<string, ProjectSnapshot>;
  readonly automations: readonly Automation[];
  readonly jobs: readonly Job[];
};

const EMPTY: ProjectSnapshot = { sources: {}, automations: [], jobs: [] };

export type Runtime = {
  /** Webhook sources of one project, by source name. */
  sources(project: string): Readonly<Record<string, Source>>;
  source(project: string, name: string): Source | undefined;
  /** Automations of every project, each tagged with its project. */
  automations(): readonly Automation[];
  /** Jobs of every project, each tagged with its project. */
  jobs(): readonly Job[];
  /** Automations and jobs of one project. */
  project(project: string): ProjectSnapshot;
  /** Re-resolves every project's settings and swaps the registered sources, automations and jobs in one step. */
  rebuild(): void;
  test(project: string, id: IntegrationId): Promise<ConnectionTestResult>;
};

export type RuntimeDeps = {
  modules: readonly IntegrationModule[];
  projects: () => readonly string[];
  resolve: (project: string) => ResolvedConfig;
  deps: ModuleDeps;
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const withProject = (log: Logger, project: string): Logger => ({
  info: (m, f) => log.info(m, { project, ...f }),
  warn: (m, f) => log.warn(m, { project, ...f }),
  error: (m, f) => log.error(m, { project, ...f }),
});

export function createRuntime({ modules, projects, resolve, deps }: RuntimeDeps): Runtime {
  const depsFor = (project: string): ModuleDeps => ({ ...deps, log: withProject(deps.log, project) });

  const buildProject = (project: string): ProjectSnapshot => {
    const config = resolve(project);
    const { log } = depsFor(project);
    const sources: Record<string, Source> = {};
    const automations: Automation[] = [];
    const jobs: Job[] = [];
    for (const module of modules) {
      if (!config[module.id].configured) continue;
      try {
        const out = module.build(config, depsFor(project));
        for (const source of out.sources ?? []) {
          if (Object.hasOwn(sources, source.name)) {
            log.error("duplicate source name, skipped", { integration: module.id, source: source.name });
            continue;
          }
          sources[source.name] = source;
        }
        automations.push(...(out.automations ?? []).map((a) => ({ ...a, project })));
        jobs.push(...(out.jobs ?? []).map((j) => ({ ...j, project })));
      } catch (err) {
        log.error("integration build failed, skipped", { integration: module.id, error: message(err) });
      }
    }
    return { sources, automations, jobs };
  };

  const build = (): Snapshot => {
    const built = new Map<string, ProjectSnapshot>();
    for (const project of projects()) built.set(project, buildProject(project));
    const all = [...built.values()];
    return { projects: built, automations: all.flatMap((p) => p.automations), jobs: all.flatMap((p) => p.jobs) };
  };

  let current: Snapshot = build();
  const of = (project: string) => current.projects.get(project) ?? EMPTY;

  return {
    sources: (project) => of(project).sources,
    source(project, name) {
      const sources = of(project).sources;
      return Object.hasOwn(sources, name) ? sources[name] : undefined;
    },
    automations: () => current.automations,
    jobs: () => current.jobs,
    project: of,
    rebuild() {
      current = build();
      for (const [project, snapshot] of current.projects) {
        deps.log.info("integrations reloaded", {
          project,
          sources: Object.keys(snapshot.sources),
          automations: snapshot.automations.map((a) => a.name),
          jobs: snapshot.jobs.map((j) => j.name),
        });
      }
    },
    async test(project, id) {
      const title = INTEGRATIONS[id].title;
      const module = modules.find((m) => m.id === id);
      if (!module?.test) return { ok: false, available: false, message: `Connection test is not available for ${title} yet` };
      const config = resolve(project);
      const resolved = config[id];
      if (!resolved.configured) {
        return { ok: false, available: true, message: `${title} is not configured. Missing: ${resolved.missing.join(", ")}` };
      }
      try {
        return await module.test(config, depsFor(project));
      } catch (err) {
        return { ok: false, available: true, message: `Connection test failed: ${message(err)}` };
      }
    },
  };
}

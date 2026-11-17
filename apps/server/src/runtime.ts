import { errorMessage } from "@automation-server/api/errors";
import type { Automation, Job, Logger, Source } from "@automation-server/core";
import { INTEGRATIONS, type ConnectionTestResult, type IntegrationId, type ResolvedConfig } from "@automation-server/settings";

import { createTokenHealthJob, type HealthSink } from "./health";
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
  sources(project: string): Readonly<Record<string, Source>>;
  source(project: string, name: string): Source | undefined;
  automations(): readonly Automation[];
  jobs(): readonly Job[];
  project(project: string): ProjectSnapshot;
  rebuild(): void;
  test(project: string, id: IntegrationId, now?: Date): Promise<ConnectionTestResult>;
};

const TEST_TIMEOUT_MS = 8_000;

const withSignal = (base: typeof fetch | undefined, signal: AbortSignal): typeof fetch =>
  ((input, init) => (base ?? fetch)(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal })) as typeof fetch;

export type RuntimeDeps = {
  modules: readonly IntegrationModule[];
  projects: () => readonly string[];
  resolve: (project: string) => ResolvedConfig;
  deps: ModuleDeps;
  testTimeoutMs?: number;
  health?: HealthSink;
};

const withProject = (log: Logger, project: string): Logger => ({
  info: (m, f) => log.info(m, { project, ...f }),
  warn: (m, f) => log.warn(m, { project, ...f }),
  error: (m, f) => log.error(m, { project, ...f }),
});

export function createRuntime({ modules, projects, resolve, deps, testTimeoutMs = TEST_TIMEOUT_MS, health }: RuntimeDeps): Runtime {
  const depsFor = (project: string): ModuleDeps => ({ ...deps, log: withProject(deps.log, project) });

  const probe = async (project: string, id: IntegrationId): Promise<ConnectionTestResult> => {
    const title = INTEGRATIONS[id].title;
    const module = modules.find((m) => m.id === id);
    if (!module?.test) return { ok: false, available: false, message: `Connection test is not available for ${title} yet` };
    const config = resolve(project);
    const resolved = config[id];
    if (!resolved.configured) {
      return { ok: false, available: true, message: `${title} is not configured. Missing: ${resolved.missing.join(", ")}` };
    }
    // Modules take a fetch, not a signal, so the abort rides on a wrapped fetch and the race covers a fetch that ignores it.
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<ConnectionTestResult>((done) => {
      timer = setTimeout(() => {
        controller.abort();
        done({ ok: false, available: true, message: `Connection test timed out after ${testTimeoutMs / 1000} s` });
      }, testTimeoutMs);
    });
    const attempt = (async (): Promise<ConnectionTestResult> => {
      try {
        return await module.test!(config, { ...depsFor(project), fetch: withSignal(deps.fetch, controller.signal) });
      } catch (err) {
        return { ok: false, available: true, message: `Connection test failed: ${errorMessage(err)}` };
      }
    })();
    try {
      return await Promise.race([attempt, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  };

  const test = async (project: string, id: IntegrationId, now = new Date()): Promise<ConnectionTestResult> => {
    const result = await probe(project, id);
    if (health && result.available && resolve(project)[id].configured) await health.record(project, id, result, now);
    return result;
  };

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
        log.error("integration build failed, skipped", { integration: module.id, error: errorMessage(err) });
      }
    }
    if (health) {
      jobs.push(
        createTokenHealthJob({
          project,
          integrations: () => {
            const current = resolve(project);
            return modules.filter((m) => m.test && !m.testHasSideEffects && current[m.id].configured).map((m) => m.id);
          },
          test: (id, now) => test(project, id, now),
        }),
      );
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
    test,
  };
}

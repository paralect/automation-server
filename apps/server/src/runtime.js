import { errorMessage } from "@automation-server/api/errors";
import { INTEGRATIONS } from "@automation-server/settings";
import { createTokenHealthJob } from "./health";
const EMPTY = { sources: {}, automations: [], jobs: [] };
const TEST_TIMEOUT_MS = 8_000;
const withSignal = (base, signal) => ((input, init) => (base ?? fetch)(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal }));
const withProject = (log, project) => ({
    info: (m, f) => log.info(m, { project, ...f }),
    warn: (m, f) => log.warn(m, { project, ...f }),
    error: (m, f) => log.error(m, { project, ...f }),
});
export function createRuntime({ modules, projects, resolve, deps, testTimeoutMs = TEST_TIMEOUT_MS, health }) {
    const depsFor = (project) => ({ ...deps, project, log: withProject(deps.log, project) });
    const probe = async (project, id, options) => {
        const title = INTEGRATIONS[id].title;
        const module = modules.find((m) => m.id === id);
        if (!module?.test)
            return { ok: false, available: false, message: `Connection test is not available for ${title} yet` };
        const config = resolve(project);
        const resolved = config[id];
        if (!resolved.configured) {
            return { ok: false, available: true, message: `${title} is not configured. Missing: ${resolved.missing.join(", ")}` };
        }
        // Modules take a fetch, not a signal, so the abort rides on a wrapped fetch and the race covers a fetch that ignores it.
        const controller = new AbortController();
        let timer;
        const timedOut = new Promise((done) => {
            timer = setTimeout(() => {
                controller.abort();
                done({ ok: false, available: true, message: `Connection test timed out after ${testTimeoutMs / 1000} s` });
            }, testTimeoutMs);
        });
        const attempt = (async () => {
            try {
                return await module.test(config, { ...depsFor(project), fetch: withSignal(deps.fetch, controller.signal) }, options);
            }
            catch (err) {
                return { ok: false, available: true, message: `Connection test failed: ${errorMessage(err)}` };
            }
        })();
        try {
            return await Promise.race([attempt, timedOut]);
        }
        finally {
            clearTimeout(timer);
        }
    };
    const test = async (project, id, now = new Date(), options) => {
        const result = await probe(project, id, options);
        if (health && result.available && resolve(project)[id].configured)
            await health.record(project, id, result, now);
        return result;
    };
    const buildProject = (project) => {
        const config = resolve(project);
        const { log } = depsFor(project);
        const sources = {};
        const automations = [];
        const jobs = [];
        for (const module of modules) {
            if (!config[module.id].configured)
                continue;
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
            }
            catch (err) {
                log.error("integration build failed, skipped", { integration: module.id, error: errorMessage(err) });
            }
        }
        if (health) {
            jobs.push(createTokenHealthJob({
                project,
                integrations: () => {
                    const current = resolve(project);
                    return modules.filter((m) => m.test && current[m.id].configured && (m.scheduledCheck?.(current) ?? true)).map((m) => m.id);
                },
                test: (id, now) => test(project, id, now, { scheduled: true }),
            }));
        }
        return { sources, automations, jobs };
    };
    const build = () => {
        const built = new Map();
        for (const project of projects())
            built.set(project, buildProject(project));
        const all = [...built.values()];
        return { projects: built, automations: all.flatMap((p) => p.automations), jobs: all.flatMap((p) => p.jobs) };
    };
    let current = build();
    const of = (project) => current.projects.get(project) ?? EMPTY;
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

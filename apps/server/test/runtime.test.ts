import type { Automation, Job, Logger, Source } from "@automation-server/core";
import { createSqliteSettingsStore, resolveConfig } from "@automation-server/settings";
import { describe, expect, test } from "bun:test";

import { defineModule, type IntegrationModule } from "../src/integrations/module";
import { createRuntime } from "../src/runtime";

const log: Logger = { info() {}, warn() {}, error() {} };
const source = (name: string): Source => ({ name, verify: () => true, parse: () => ({ type: "ignored", reason: "x" }) });
const automation = (name: string): Automation => ({ name, matches: () => false, run: async () => {} });
const job = (name: string): Job => ({ name, due: () => null, run: async () => {} });

const setup = (modules: IntegrationModule[], env: Record<string, string> = {}) => {
  const store = createSqliteSettingsStore({ path: ":memory:", encryptionKey: "k" });
  const runtime = createRuntime({ modules, resolve: () => resolveConfig(store, env), deps: { log } });
  return { store, runtime };
};

describe("runtime", () => {
  test("builds only configured integrations and picks up settings on rebuild", () => {
    const sentry = defineModule({
      id: "sentry",
      build: () => ({ sources: [source("sentry")], automations: [automation("a")], jobs: [job("j")] }),
    });
    const { store, runtime } = setup([sentry]);
    expect(Object.keys(runtime.sources())).toEqual([]);
    store.apply({ set: [{ key: "sentry.clientSecret", json: '"s"', secret: true }] });
    expect(Object.keys(runtime.sources())).toEqual([]);
    runtime.rebuild();
    expect(Object.keys(runtime.sources())).toEqual(["sentry"]);
    expect(runtime.automations().map((a) => a.name)).toEqual(["a"]);
    expect(runtime.jobs().map((j) => j.name)).toEqual(["j"]);
  });

  test("a rebuild swaps atomically: a held snapshot is unchanged and the getters see the new one", () => {
    const sentry = defineModule({ id: "sentry", build: () => ({ automations: [automation("a")] }) });
    const { store, runtime } = setup([sentry], { SENTRY_CLIENT_SECRET: "s" });
    const before = runtime.automations();
    store.apply({ set: [{ key: "sentry.minEventCount", json: "2", secret: false }] });
    runtime.rebuild();
    expect(before.map((a) => a.name)).toEqual(["a"]);
    expect(runtime.automations()).not.toBe(before);
  });

  test("a module that throws is skipped and the others still register", () => {
    const bad = defineModule({
      id: "sentry",
      build: () => {
        throw new Error("boom");
      },
    });
    const good = defineModule({ id: "github", build: () => ({ sources: [source("g")] }) });
    const { runtime } = setup([bad, good], { SENTRY_CLIENT_SECRET: "s", GITHUB_TOKEN: "t" });
    expect(Object.keys(runtime.sources())).toEqual(["g"]);
  });

  test("a duplicate source name keeps the first", () => {
    const a = defineModule({ id: "sentry", build: () => ({ sources: [source("x")] }) });
    const b = defineModule({ id: "github", build: () => ({ sources: [source("x")] }) });
    const { runtime } = setup([a, b], { SENTRY_CLIENT_SECRET: "s", GITHUB_TOKEN: "t" });
    expect(runtime.sources().x).toBeDefined();
    expect(Object.keys(runtime.sources())).toHaveLength(1);
  });

  test("test() delegates to the module hook and reports not available without one", async () => {
    const withHook = defineModule({
      id: "github",
      build: () => ({}),
      test: async () => ({ ok: true, available: true, message: "fine" }),
    });
    const without = defineModule({ id: "sentry", build: () => ({}) });
    const { runtime } = setup([withHook, without], { GITHUB_TOKEN: "t", SENTRY_CLIENT_SECRET: "s" });
    expect(await runtime.test("github")).toEqual({ ok: true, available: true, message: "fine" });
    expect(await runtime.test("sentry")).toMatchObject({ ok: false, available: false });
    expect(await runtime.test("linear")).toMatchObject({ ok: false, available: false });
  });

  test("test() on an unconfigured integration names what is missing, and a throwing hook becomes a result", async () => {
    const throwing = defineModule({
      id: "github",
      build: () => ({}),
      test: async () => {
        throw new Error("network down");
      },
    });
    const { runtime } = setup([throwing]);
    expect(await runtime.test("github")).toMatchObject({ ok: false, message: expect.stringContaining("token") });
    const configured = setup([throwing], { GITHUB_TOKEN: "t" }).runtime;
    expect(await configured.test("github")).toMatchObject({ ok: false, message: expect.stringContaining("network down") });
  });
});

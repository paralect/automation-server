import { createSqliteSettingsStore, envFor, resolveConfig } from "@automation-server/settings";
import { describe, expect, test } from "bun:test";
import { linear } from "../src/integrations/linear";
import { createRuntime } from "../src/runtime";
const log = { info() { }, warn() { }, error() { } };
const KEY = "lin_api_SECRETKEY1234567890abcdef";
const setup = (apiKey, viewer) => {
    const calls = [];
    const fetch = (async (input) => {
        calls.push(String(input));
        return viewer.clone();
    });
    const store = createSqliteSettingsStore({ path: ":memory:", encryptionKey: "k" });
    const set = (key, value, secret = false) => ({ key, json: JSON.stringify(value), secret });
    store.apply({
        set: [
            set("linear.webhookSecret", "whsec", true),
            set("linear.triggerLabel", "codex"),
            set("linear.targetRepo", "acme/app"),
            ...(apiKey ? [set("linear.apiKey", apiKey, true)] : []),
        ],
    });
    const runtime = createRuntime({
        modules: [linear],
        projects: () => ["default"],
        resolve: (p) => resolveConfig(store.project(p), envFor(p, {})),
        deps: { log, fetch },
    });
    return { calls, runtime };
};
describe("linear module test", () => {
    test("with an API key it also verifies the key with a viewer query and never echoes it", async () => {
        const { calls, runtime } = setup(KEY, Response.json({ data: { viewer: { name: "Ada" }, organization: { name: "Acme" } } }));
        const result = await runtime.test("default", "linear");
        expect(calls).toContain("https://api.linear.app/graphql");
        expect(result.message).toContain("API key works for Ada in Acme");
        expect(JSON.stringify(result)).not.toContain(KEY);
    });
    test("a rejected key fails the test", async () => {
        const { runtime } = setup(KEY, new Response("{}", { status: 401 }));
        const result = await runtime.test("default", "linear");
        expect(result.ok).toBe(false);
        expect(result.message).toContain("rejected");
        expect(JSON.stringify(result)).not.toContain(KEY);
    });
    test("without an API key Linear is not called", async () => {
        const { calls, runtime } = setup(undefined, Response.json({}));
        const result = await runtime.test("default", "linear");
        expect(calls.some((c) => c.includes("api.linear.app"))).toBe(false);
        expect(result.message).toContain("nothing will run until the GitHub token is set");
    });
});

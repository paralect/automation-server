import { createSqliteSettingsStore, envFor, resolveConfig } from "@automation-server/settings";
import { describe, expect, test } from "bun:test";
import { slack } from "../src/integrations/slack";
import { createRuntime } from "../src/runtime";
const log = { info() { }, warn() { }, error() { } };
const HOOK = "https://hooks.slack.com/services/T000/B000/SECRETSECRET";
const setup = (env, fetch) => {
    const store = createSqliteSettingsStore({ path: ":memory:", encryptionKey: "k" });
    return createRuntime({
        modules: [slack],
        projects: () => ["default"],
        resolve: (p) => resolveConfig(store.project(p), envFor(p, env)),
        deps: { log, fetch },
    });
};
const recorder = (status = 200) => {
    const calls = [];
    const fetch = (async (url, init) => {
        calls.push({ url: String(url), body: String(init?.body) });
        return new Response(status === 200 ? "ok" : `nope ${HOOK}`, { status });
    });
    return { calls, fetch };
};
describe("slack module test", () => {
    test("posts the test message and reports ok without the webhook url", async () => {
        const { calls, fetch } = recorder();
        const result = await setup({ SLACK_ALERTS_WEBHOOK_URL: HOOK }, fetch).test("default", "slack");
        expect(result.ok).toBe(true);
        expect(calls).toEqual([{ url: HOOK, body: JSON.stringify({ text: "Automation server alerts are connected" }) }]);
        expect(JSON.stringify(result)).not.toContain("SECRETSECRET");
    });
    test("a Slack error comes back as not ok and never echoes the webhook url", async () => {
        const { fetch } = recorder(500);
        const result = await setup({ SLACK_ALERTS_WEBHOOK_URL: HOOK }, fetch).test("default", "slack");
        expect(result.ok).toBe(false);
        expect(result.message).toContain("HTTP 500");
        expect(JSON.stringify(result)).not.toContain("SECRETSECRET");
    });
    test("an unconfigured webhook is not posted to", async () => {
        const { calls, fetch } = recorder();
        const result = await setup({}, fetch).test("default", "slack");
        expect(result.ok).toBe(false);
        expect(calls).toEqual([]);
    });
});

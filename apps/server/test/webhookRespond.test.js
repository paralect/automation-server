import { createDispatcher, createSqliteStore } from "@automation-server/core";
import { describe, expect, test } from "bun:test";
import { createWebhookRoutes } from "../src/webhooks";
const log = { info() { }, warn() { }, error() { } };
const setup = (source) => {
    const seen = [];
    const dispatcher = createDispatcher({
        automations: () => [{ name: "probe", project: "default", matches: () => true, run: async (event) => void seen.push(event) }],
        store: createSqliteStore({ path: ":memory:" }),
        log,
    });
    const app = createWebhookRoutes({ source: (_p, name) => (name === source.name ? source : undefined), defaultProject: "default", dispatcher, log });
    const post = (name, body = "{}") => app.request(`/webhooks/${name}`, { method: "POST", body });
    return { post, dispatcher, seen };
};
const parsed = (_r, receivedAt) => ({
    type: "event",
    event: { source: "plain", kind: "k", externalId: "1", receivedAt: receivedAt.toISOString(), payload: {} },
});
describe("Source.respond", () => {
    test("a source without respond behaves as before", async () => {
        const t = setup({ name: "plain", verify: () => true, parse: parsed });
        const res = await t.post("plain");
        expect(await res.json()).toEqual({ ok: true });
        await t.dispatcher.drain(500);
        expect(t.seen).toHaveLength(1);
    });
    test("a reply is the response body and nothing is dispatched", async () => {
        const t = setup({ name: "plain", verify: () => true, respond: () => ({ body: { challenge: "abc" } }), parse: parsed });
        const res = await t.post("plain");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ challenge: "abc" });
        await t.dispatcher.drain(500);
        expect(t.seen).toHaveLength(0);
    });
    test("respond returning undefined falls through to parse", async () => {
        const t = setup({ name: "plain", verify: () => true, respond: () => undefined, parse: parsed });
        expect(await (await t.post("plain")).json()).toEqual({ ok: true });
        await t.dispatcher.drain(500);
        expect(t.seen).toHaveLength(1);
    });
    test("respond never runs for an unverified request", async () => {
        let called = false;
        const t = setup({
            name: "plain",
            verify: () => false,
            respond: () => {
                called = true;
                return { body: { challenge: "abc" } };
            },
            parse: parsed,
        });
        const res = await t.post("plain");
        expect(res.status).toBe(401);
        expect(called).toBe(false);
    });
});

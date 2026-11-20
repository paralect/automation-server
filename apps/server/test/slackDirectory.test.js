import { SlackDirectoryError } from "@automation-server/api/slackDirectory";
import { createSqliteSettingsStore, envFor, resolveConfig } from "@automation-server/settings";
import { describe, expect, test } from "bun:test";
import { createSlackDirectory, DIRECTORY_TTL_MS } from "../src/slackDirectory";
const world = (token = "xoxb-a", maxCached = 2) => {
    const store = createSqliteSettingsStore({ path: ":memory:", encryptionKey: "k" });
    const setToken = (value) => store.project("default").apply({ set: [{ key: "slack.botToken", json: JSON.stringify(value), secret: true }], remove: [] });
    setToken(token);
    let clock = 1_000;
    const calls = [];
    const fetch = (async (url, init) => {
        const method = new URL(String(url)).pathname.split("/").pop();
        calls.push({ method, auth: (init?.headers).authorization });
        return Response.json(method === "users.list" ? { ok: true, members: [{ id: "U1", name: "alice" }] } : { ok: true, channels: [{ id: "C1", name: "general", is_member: true }] });
    });
    const directory = createSlackDirectory({ resolve: (p) => resolveConfig(store.project(p), envFor(p, {})), fetch, now: () => clock, maxCached });
    return { directory, calls, setToken, advance: (ms) => (clock += ms) };
};
describe("slack directory cache", () => {
    test("a second call within a minute makes no Slack request", async () => {
        const { directory, calls, advance } = world();
        await directory.list({ project: "default", kind: "users" });
        await directory.list({ project: "default", kind: "users", search: "ali" });
        advance(DIRECTORY_TTL_MS - 1);
        await directory.list({ project: "default", kind: "users" });
        expect(calls).toHaveLength(1);
        advance(1);
        await directory.list({ project: "default", kind: "users" });
        expect(calls).toHaveLength(2);
    });
    test("refresh bypasses the cache", async () => {
        const { directory, calls } = world();
        await directory.list({ project: "default", kind: "users" });
        await directory.list({ project: "default", kind: "users", refresh: true });
        expect(calls).toHaveLength(2);
    });
    test("users and channels are cached separately", async () => {
        const { directory, calls } = world();
        await directory.list({ project: "default", kind: "users" });
        await directory.list({ project: "default", kind: "channels" });
        expect(calls.map((c) => c.method)).toEqual(["users.list", "users.conversations", "conversations.list"]);
    });
    test("a new token is never answered from the old token's rows", async () => {
        const { directory, calls, setToken } = world("xoxb-a");
        await directory.list({ project: "default", kind: "users" });
        setToken("xoxb-b");
        await directory.list({ project: "default", kind: "users" });
        expect(calls.map((c) => c.auth)).toEqual(["Bearer xoxb-a", "Bearer xoxb-b"]);
    });
    test("a failure is not cached", async () => {
        const store = createSqliteSettingsStore({ path: ":memory:", encryptionKey: "k" });
        store.project("default").apply({ set: [{ key: "slack.botToken", json: '"xoxb-a"', secret: true }], remove: [] });
        let ok = false;
        let requests = 0;
        const fetch = (async () => {
            requests++;
            return Response.json(ok ? { ok: true, members: [] } : { ok: false, error: "ratelimited" });
        });
        const directory = createSlackDirectory({ resolve: (p) => resolveConfig(store.project(p), envFor(p, {})), fetch });
        const first = await directory.list({ project: "default", kind: "users" }).catch((e) => e);
        expect(first).toBeInstanceOf(SlackDirectoryError);
        expect(first.kind).toBe("failed");
        ok = true;
        await directory.list({ project: "default", kind: "users" });
        expect(requests).toBe(2);
    });
    test("the cache stays bounded, dropping the oldest entry first", async () => {
        const { directory, calls } = world("xoxb-a", 1);
        await directory.list({ project: "default", kind: "users" });
        await directory.list({ project: "default", kind: "channels" });
        await directory.list({ project: "default", kind: "users" });
        expect(calls.filter((c) => c.method === "users.list")).toHaveLength(2);
    });
});

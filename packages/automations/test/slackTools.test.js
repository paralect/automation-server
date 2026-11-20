import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { API_KEY, CONFIG, fakeFetch } from "./posthogWeeklyReport/fakes";
import { buildReadTools, createToolRegistry, defineTool, executeTool, MAX_TOOL_RESULT_CHARS } from "../src/slackBot/tools";
const ctx = { requestedBy: "U1", channel: "C1", threadTs: "1.1", dryRun: false };
const TOKEN = "ghp_secretTokenValue1234567890";
const router = (routes) => {
    const calls = [];
    const fn = (async (input, init) => {
        const call = { url: new URL(String(input)), headers: (init?.headers ?? {}) };
        calls.push(call);
        const handler = routes[call.url.pathname];
        if (!handler)
            return new Response("not found", { status: 404 });
        const body = handler(call);
        return body instanceof Response ? body : Response.json(body);
    });
    return { fn, calls };
};
const named = (tools, name) => tools.find((t) => t.name === name);
describe("github tools", () => {
    const issue = { number: 7, title: "Billing page 500", state: "open", html_url: "https://github.com/acme/app/issues/7", labels: [{ name: "bug" }] };
    test("searchIssues is pinned to the configured repository even if the query names another", async () => {
        const { fn, calls } = router({ "/search/issues": () => ({ items: [issue] }) });
        const tools = buildReadTools({ github: { token: TOKEN, repo: { owner: "acme", name: "app" } }, fetch: fn });
        const result = await executeTool(named(tools, "github.searchIssues"), { query: "billing repo:evil/secret org:evil", limit: 3 }, ctx);
        expect(result.ok && JSON.parse(result.text)).toEqual([
            { number: 7, title: "Billing page 500", state: "open", url: "https://github.com/acme/app/issues/7", labels: ["bug"], isPullRequest: false },
        ]);
        const q = calls[0].url.searchParams.get("q");
        expect(q).toBe("billing repo:acme/app is:issue");
        expect(calls[0].url.searchParams.get("per_page")).toBe("3");
    });
    test("getIssue returns the body, and a 404 is a tool error", async () => {
        const { fn } = router({
            "/repos/acme/app/issues/7": () => ({ ...issue, body: "details", user: { login: "ada" }, comments: 2 }),
            "/repos/acme/app/issues/8": () => new Response("{}", { status: 404 }),
        });
        const tools = buildReadTools({ github: { token: TOKEN, repo: { owner: "acme", name: "app" } }, fetch: fn });
        const found = await executeTool(named(tools, "github.getIssue"), { number: 7 }, ctx);
        expect(found.ok && JSON.parse(found.text)).toMatchObject({ number: 7, body: "details", author: "ada", comments: 2 });
        const missing = await executeTool(named(tools, "github.getIssue"), { number: 8 }, ctx);
        expect(missing).toEqual({ ok: false, error: "Issue #8 was not found in acme/app" });
    });
    test("an API failure is a tool error without the token", async () => {
        const { fn } = router({ "/search/issues": () => new Response(JSON.stringify({ message: `bad ${TOKEN}` }), { status: 403 }) });
        const tools = buildReadTools({ github: { token: TOKEN, repo: { owner: "acme", name: "app" } }, fetch: fn });
        const result = await executeTool(named(tools, "github.searchIssues"), { query: "x" }, ctx);
        expect(result.ok).toBe(false);
        expect(JSON.stringify(result)).not.toContain(TOKEN);
    });
});
describe("sentry tools", () => {
    const SENTRY_TOKEN = "sntrys_secretToken1234567890abcdef";
    const sentryIssue = { shortId: "APP-1", title: "TypeError", level: "error", status: "unresolved", count: "42", userCount: 3, firstSeen: "a", lastSeen: "b", permalink: "https://sentry.io/x" };
    test("lists issues of the token's organization with the bearer token and the configured host", async () => {
        const { fn, calls } = router({
            "/api/0/organizations/": () => [{ slug: "acme" }],
            "/api/0/organizations/acme/issues/": () => [sentryIssue],
        });
        const tools = buildReadTools({ sentry: { authToken: SENTRY_TOKEN, apiBaseUrl: "https://sentry.example/" }, fetch: fn });
        const result = await executeTool(named(tools, "sentry.listIssues"), { query: "is:unresolved level:error", limit: 2 }, ctx);
        expect(result.ok && JSON.parse(result.text)).toEqual([{ ...sentryIssue, count: 42 }]);
        expect(calls.every((c) => c.url.origin === "https://sentry.example")).toBe(true);
        expect(calls[1].headers.Authorization).toBe(`Bearer ${SENTRY_TOKEN}`);
        expect(calls[1].url.searchParams.get("query")).toBe("is:unresolved level:error");
        expect(calls[1].url.searchParams.get("limit")).toBe("2");
    });
    test("a rejected token is a tool error", async () => {
        const { fn } = router({ "/api/0/organizations/": () => new Response("{}", { status: 401 }) });
        const tools = buildReadTools({ sentry: { authToken: SENTRY_TOKEN, apiBaseUrl: "https://sentry.io" }, fetch: fn });
        const result = await executeTool(named(tools, "sentry.listIssues"), {}, ctx);
        expect(result).toEqual({ ok: false, error: "sentry.listIssues failed: Sentry request failed: HTTP 401" });
    });
});
describe("posthog tool", () => {
    test("returns the weekly report text and posts nothing to Slack", async () => {
        const { fn, calls, slackPosts } = fakeFetch();
        const tools = buildReadTools({ posthog: CONFIG, fetch: fn });
        const tool = named(tools, "posthog.weeklyReport");
        expect(tool.kind).toBe("read");
        const result = await executeTool(tool, {}, ctx);
        expect(result.ok && result.text).toContain("Unique users");
        expect(calls.length).toBeGreaterThan(0);
        expect(slackPosts()).toHaveLength(0);
        expect(JSON.stringify(result)).not.toContain(API_KEY);
    });
});
describe("linear tools", () => {
    const node = { identifier: "ENG-1", title: "Billing bug", url: "https://linear.app/a/issue/ENG-1", state: { name: "Todo" }, assignee: null };
    test("searchIssues and getIssue go through the GraphQL client", async () => {
        const { fn, calls } = router({
            "/graphql": (call) => {
                void call;
                return { data: { searchIssues: { nodes: [node] } } };
            },
        });
        const tools = buildReadTools({ linear: { apiKey: "lin_api_secretsecretsecret" }, fetch: fn });
        const found = await executeTool(named(tools, "linear.searchIssues"), { query: "billing" }, ctx);
        expect(found.ok && JSON.parse(found.text)).toEqual([{ identifier: "ENG-1", title: "Billing bug", url: node.url, state: "Todo", assignee: null }]);
        expect(calls[0].headers.authorization).toBe("lin_api_secretsecretsecret");
    });
    test("getIssue rejects a malformed identifier before any request", async () => {
        const { fn, calls } = router({});
        const tools = buildReadTools({ linear: { apiKey: "k" }, fetch: fn });
        const result = await executeTool(named(tools, "linear.getIssue"), { identifier: "ENG-1; drop" }, ctx);
        expect(result.ok).toBe(false);
        expect(calls).toHaveLength(0);
    });
    test("a missing issue is a tool error", async () => {
        const { fn } = router({ "/graphql": () => ({ data: { issue: null } }) });
        const tools = buildReadTools({ linear: { apiKey: "k" }, fetch: fn });
        expect(await executeTool(named(tools, "linear.getIssue"), { identifier: "eng-9" }, ctx)).toEqual({ ok: false, error: "Linear issue eng-9 was not found" });
    });
});
describe("tool offering", () => {
    test("only configured integrations contribute tools, and all are read tools", () => {
        expect(buildReadTools({})).toEqual([]);
        const tools = buildReadTools({ linear: { apiKey: "k" } });
        expect(tools.map((t) => t.name)).toEqual(["linear.searchIssues", "linear.getIssue"]);
        const all = buildReadTools({
            github: { token: "t", repo: { owner: "a", name: "b" } },
            sentry: { authToken: "t", apiBaseUrl: "https://sentry.io" },
            posthog: { host: "h", projectId: "1", personalApiKey: "k", slackWebhookUrl: "u", reportTitle: "t", dayOfWeek: 1, hourUtc: 9 },
            linear: { apiKey: "k" },
        });
        expect(all.map((t) => t.name)).toEqual(["github.searchIssues", "github.getIssue", "sentry.listIssues", "posthog.weeklyReport", "linear.searchIssues", "linear.getIssue"]);
        expect(all.every((t) => t.kind === "read")).toBe(true);
    });
    test("duplicate names are rejected", () => {
        const tool = defineTool({ name: "x", description: "", kind: "read", argsSchema: z.object({}), run: async () => ({ ok: true, text: "" }) });
        expect(() => createToolRegistry([tool, tool])).toThrow("duplicate tool name: x");
    });
});
describe("executeTool", () => {
    const make = (text) => defineTool({
        name: "t.echo",
        description: "",
        kind: "read",
        argsSchema: z.object({ n: z.number() }),
        run: async () => (typeof text === "string" ? { ok: true, text } : text()),
    });
    test("invalid arguments never reach run", async () => {
        let ran = false;
        const tool = defineTool({ name: "t.x", description: "", kind: "read", argsSchema: z.object({ n: z.number() }), run: async () => ((ran = true), { ok: true, text: "" }) });
        const result = await executeTool(tool, { n: "nope" }, ctx);
        expect(result.ok).toBe(false);
        expect(ran).toBe(false);
    });
    test("a hostile 200k character result or error is handled well under 200 ms", async () => {
        const hostile = "a".repeat(200_000);
        const started = performance.now();
        const ok = await executeTool(make(hostile), { n: 1 }, ctx);
        const failed = await executeTool(make(() => Promise.reject(new Error(hostile))), { n: 1 }, ctx);
        expect(performance.now() - started).toBeLessThan(200);
        expect(ok.ok).toBe(true);
        expect(failed.ok).toBe(false);
    });
    test("results are redacted and then truncated", async () => {
        const secret = "Authorization: Bearer abcdef0123456789abcdef0123456789";
        const result = await executeTool(make(`${secret}\n${"y".repeat(10_000)}`), { n: 1 }, ctx);
        expect(result.ok && result.text.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
        expect(result.ok && result.text).not.toContain("abcdef0123456789");
    });
    test("a throwing tool becomes an error result with the message redacted", async () => {
        const tool = make(async () => {
            throw new Error("boom with token=hunter2hunter2");
        });
        const result = await executeTool(tool, { n: 1 }, ctx);
        expect(result).toEqual({ ok: false, error: expect.stringContaining("t.echo failed: boom") });
        expect(JSON.stringify(result)).not.toContain("hunter2");
    });
});

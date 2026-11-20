import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { createCrispSource, isCrispSession, parseCrispWebhook } from "../src";
const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const segments = fixture("crisp-session-set-segments.json");
const state = fixture("crisp-session-set-state.json");
const WEBSITE = "8c842203-7ed8-4e29-a608-7cf78a7d2fcc";
const SESSION = "session_700c65e1-85e2-465a-b9ac-ecb5ec2c9881";
const secret = "crisp-signing-secret";
const NOW = 1763290000000;
const at = new Date(NOW);
const sign = (body, timestamp, key = secret) => createHmac("sha256", key).update(`[${timestamp};${new TextDecoder().decode(body)}]`).digest("hex");
const headers = (body, timestamp = String(NOW), signature = sign(body, timestamp)) => new Headers({ "x-crisp-request-timestamp": timestamp, "x-crisp-signature": signature });
const encode = (value) => new TextEncoder().encode(JSON.stringify(value));
function fakeCrisp(messages, conversation = { meta: { email: "jane@example.com", segments: ["triage"] } }) {
    const calls = [];
    const fn = (async (input, init) => {
        calls.push({ url: String(input), method: init?.method ?? "GET", headers: init?.headers });
        const data = String(input).endsWith("/messages") ? messages : conversation;
        return new Response(JSON.stringify({ error: false, reason: "resolved", data }), { status: 200 });
    });
    return { fn, calls };
}
const source = (f) => createCrispSource({
    websiteId: WEBSITE,
    webhookSecret: secret,
    pluginIdentifier: "plugin-id",
    pluginKey: "plugin-key",
    fetch: f,
    now: () => NOW,
});
describe("crisp signature", () => {
    test("accepts a delivery signed over [timestamp;body]", () => {
        expect(source().verify({ headers: headers(segments), rawBody: segments })).toBe(true);
    });
    test("rejects a tampered body, a wrong secret and missing headers", () => {
        const tampered = segments.slice();
        tampered[20] = tampered[20] ^ 1;
        expect(source().verify({ headers: headers(segments), rawBody: tampered })).toBe(false);
        expect(source().verify({ headers: headers(segments, String(NOW), sign(segments, String(NOW), "other")), rawBody: segments })).toBe(false);
        expect(source().verify({ headers: new Headers(), rawBody: segments })).toBe(false);
        expect(source().verify({ headers: headers(segments, String(NOW), "zz"), rawBody: segments })).toBe(false);
    });
    test("rejects a signature over another timestamp", () => {
        const h = headers(segments, String(NOW), sign(segments, String(NOW - 1000)));
        expect(source().verify({ headers: h, rawBody: segments })).toBe(false);
    });
    test("rejects a correctly signed delivery older than five minutes", () => {
        const stale = String(NOW - 5 * 60_000 - 1);
        expect(source().verify({ headers: headers(segments, stale), rawBody: segments })).toBe(false);
        const recent = String(NOW - 4 * 60_000);
        expect(source().verify({ headers: headers(segments, recent), rawBody: segments })).toBe(true);
    });
});
describe("parseCrispWebhook", () => {
    test("segments change becomes a segments event keyed by session", () => {
        const r = parseCrispWebhook(segments, at, WEBSITE);
        if (r.type !== "event")
            throw new Error("expected event");
        expect(r.event).toMatchObject({
            source: "crisp",
            kind: "segments",
            externalId: `${SESSION}:triage`,
            payload: { websiteId: WEBSITE, sessionId: SESSION, segments: ["vip", "Triage"], request: null },
        });
        expect(isCrispSession(r.event)).toBe(true);
    });
    test("resolved state becomes a resolved event", () => {
        const r = parseCrispWebhook(state, at, WEBSITE);
        if (r.type !== "event")
            throw new Error("expected event");
        expect(r.event).toMatchObject({ kind: "resolved", externalId: `${SESSION}:resolved`, payload: { sessionId: SESSION, segments: [] } });
    });
    test("other states, other events, another website and bad bodies are ignored", () => {
        const pending = encode({ website_id: WEBSITE, event: "session:set_state", data: { session_id: SESSION, state: "pending" } });
        expect(parseCrispWebhook(pending, at, WEBSITE)).toEqual({ type: "ignored", reason: "unsupported_state:pending" });
        const message = encode({ website_id: WEBSITE, event: "message:send", data: { session_id: SESSION } });
        expect(parseCrispWebhook(message, at, WEBSITE)).toEqual({ type: "ignored", reason: "unsupported_event:message:send" });
        expect(parseCrispWebhook(segments, at, "another-website")).toEqual({ type: "ignored", reason: "website_mismatch" });
        expect(parseCrispWebhook(encode({ nope: 1 }), at, WEBSITE)).toEqual({ type: "ignored", reason: "invalid_payload_shape" });
        expect(parseCrispWebhook(new TextEncoder().encode("{"), at, WEBSITE)).toEqual({ type: "ignored", reason: "invalid_json" });
    });
});
describe("crisp enrich", () => {
    const parsed = () => {
        const r = parseCrispWebhook(segments, at, WEBSITE);
        if (r.type !== "event")
            throw new Error("expected event");
        return r.event;
    };
    test("loads the conversation in order, keeping user and operator text and operator notes but not its own notes", async () => {
        const { fn, calls } = fakeCrisp([
            { type: "text", from: "operator", content: "Which browser?", timestamp: NOW + 2000 },
            { type: "text", from: "user", content: "Export button does nothing", timestamp: NOW + 1000 },
            { type: "file", from: "user", content: { url: "https://x/y.png" }, timestamp: NOW + 3000 },
            { type: "note", from: "operator", content: "Seen this on Safari before", timestamp: NOW + 4000 },
            { type: "note", from: "operator", content: "[automation-server triage] category: bug", timestamp: NOW + 5000 },
        ]);
        const enriched = (await source(fn).enrich(parsed()));
        expect(enriched.payload.request).toEqual({
            sessionId: SESSION,
            websiteId: WEBSITE,
            customer: { email: "jane@example.com" },
            messages: [
                { from: "user", at: new Date(NOW + 1000).toISOString(), text: "Export button does nothing" },
                { from: "operator", at: new Date(NOW + 2000).toISOString(), text: "Which browser?" },
                { from: "operator", at: new Date(NOW + 4000).toISOString(), text: "Seen this on Safari before" },
            ],
            segments: ["triage"],
        });
        expect(calls.map((c) => c.url).sort()).toEqual([
            `https://api.crisp.chat/v1/website/${WEBSITE}/conversation/${SESSION}`,
            `https://api.crisp.chat/v1/website/${WEBSITE}/conversation/${SESSION}/messages`,
        ]);
        expect(calls[0]?.headers).toMatchObject({
            Authorization: `Basic ${Buffer.from("plugin-id:plugin-key").toString("base64")}`,
            "X-Crisp-Tier": "plugin",
        });
    });
    test("follows timestamp_before while pages are full", async () => {
        const page = (from) => Array.from({ length: 20 }, (_, i) => ({ type: "text", from: "user", content: `m${from - i}`, timestamp: from - i }));
        const urls = [];
        const fn = (async (input) => {
            const url = String(input);
            urls.push(url);
            if (url.endsWith(`/conversation/${SESSION}`))
                return new Response(JSON.stringify({ data: { meta: {}, segments: [] } }));
            const body = url.includes("timestamp_before=981") ? [{ type: "text", from: "user", content: "first", timestamp: 5 }] : page(1000);
            return new Response(JSON.stringify({ data: body }));
        });
        const enriched = (await source(fn).enrich(parsed()));
        expect(enriched.payload.request?.messages).toHaveLength(21);
        expect(enriched.payload.request?.messages[0]?.text).toBe("first");
        expect(urls.filter((u) => u.includes("/messages"))).toHaveLength(2);
    });
    test("an API failure throws without leaking the plugin key", async () => {
        const fn = (async () => new Response(JSON.stringify({ error: true, reason: "invalid_session" }), { status: 401 }));
        const err = (await source(fn).enrich(parsed()).catch((e) => e));
        expect(err.message).toContain("status 401: invalid_session");
        expect(err.message).not.toContain("plugin-key");
    });
});

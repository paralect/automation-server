import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { createSentryIssueEnricher, createSentrySource, isSentryIssueAlert, parseSentryWebhook, verifySignature, } from "../src";
const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const sample = fixture("sentry-event-alert.json");
const rich = fixture("sentry-event-alert-rich.json");
const secret = "client-secret";
const sign = (body, key = secret) => createHmac("sha256", key).update(body).digest("hex");
const hdrs = (resource = "event_alert") => new Headers({ "sentry-hook-resource": resource });
const at = new Date("2026-01-01T00:00:00Z");
describe("verifySignature", () => {
    test("accepts a valid signature", () => {
        expect(verifySignature(sample, sign(sample), secret)).toBe(true);
    });
    test("rejects a tampered body", () => {
        const tampered = sample.slice();
        tampered[10] = tampered[10] ^ 1;
        expect(verifySignature(tampered, sign(sample), secret)).toBe(false);
    });
    test("rejects a missing header", () => {
        expect(verifySignature(sample, null, secret)).toBe(false);
    });
    test("rejects a wrong secret and an empty secret", () => {
        expect(verifySignature(sample, sign(sample, "other"), secret)).toBe(false);
        expect(verifySignature(sample, sign(sample, ""), "")).toBe(false);
    });
    test("rejects non-hex and wrong-length signatures without throwing", () => {
        expect(verifySignature(sample, "z".repeat(64), secret)).toBe(false);
        expect(verifySignature(sample, "abcd", secret)).toBe(false);
        expect(verifySignature(sample, "", secret)).toBe(false);
    });
    test("rejects a signature of re-serialized JSON", () => {
        const text = new TextDecoder().decode(sample);
        const reserialized = new TextEncoder().encode(JSON.stringify(JSON.parse(text)));
        expect(verifySignature(reserialized, sign(sample), secret)).toBe(false);
    });
});
describe("parseSentryWebhook", () => {
    test("parses the documented sample", () => {
        const r = parseSentryWebhook(hdrs(), sample, at);
        if (r.type !== "event")
            throw new Error("expected event");
        expect(r.event).toMatchObject({
            source: "sentry",
            kind: "issue_alert",
            externalId: "1117540176",
            receivedAt: "2026-01-01T00:00:00.000Z",
        });
        const p = r.event.payload;
        expect(p.title).toBe("ReferenceError: heck is not defined");
        expect(p.level).toBe("error");
        expect(p.culprit).toBe("?(<anonymous>)");
        expect(p.issueApiUrl).toBe("https://sentry.io/api/0/issues/1117540176/");
        expect(p.eventWebUrl).toBe("https://sentry.io/organizations/test-org/issues/1117540176/events/e4874d664c3540c1a32eab185f12c5ab/");
        expect(p.release).toBeNull();
        expect(p.environment).toBeNull();
        expect(p.ruleName).toBe("Very Important Alert!");
        expect(p.breadcrumbs).toEqual([]);
        expect(p.exceptions).toHaveLength(1);
        expect(p.exceptions[0].frames).toHaveLength(3);
        expect(p.exceptions[0].frames.every((f) => !f.inApp)).toBe(true);
    });
    test("parses the rich fixture and drops user/request data", () => {
        const r = parseSentryWebhook(hdrs(), rich, at);
        if (r.type !== "event")
            throw new Error("expected event");
        const p = r.event.payload;
        expect(p.environment).toBe("production");
        expect(p.release).toBe("web@1.2.3");
        expect(p.level).toBe("fatal");
        expect(p.exceptions[0].frames.map((f) => f.inApp)).toEqual([false, true]);
        expect(p.exceptions[0].frames[1].contextLine).toBe("const total = cart.items.length;");
        expect(p.breadcrumbs).toHaveLength(2);
        expect(p.breadcrumbs[0]).toEqual({
            timestamp: "2026-01-02T03:04:01Z",
            type: "http",
            category: "fetch",
            level: "info",
            message: null,
            url: "https://api.example.com/cart",
            method: "GET",
            statusCode: 200,
        });
        expect(p.breadcrumbs[1].timestamp).toBe("2026-01-02T03:04:03.500Z");
        const json = JSON.stringify(r.event);
        for (const leak of [
            "jane.doe",
            "203.0.113",
            "COOKIE_LEAK",
            "HEADER_LEAK",
            "UA_LEAK",
            "DATA_LEAK",
            "VARS_LEAK",
            "CONTEXT_LEAK",
            "BC_HEADER_LEAK",
        ]) {
            expect(json).not.toContain(leak);
        }
    });
    test("reads breadcrumbs from an entries item", () => {
        const body = JSON.stringify({
            data: {
                event: {
                    issue_id: 7,
                    entries: [
                        { type: "message", data: {} },
                        { type: "breadcrumbs", data: { values: [{ category: "nav", message: "go" }, 5] } },
                    ],
                },
            },
        });
        const r = parseSentryWebhook(hdrs(), new TextEncoder().encode(body), at);
        if (r.type !== "event")
            throw new Error("expected event");
        const p = r.event.payload;
        expect(r.event.externalId).toBe("7");
        expect(p.breadcrumbs.map((b) => b.category)).toEqual(["nav"]);
    });
    test("ignores other resources, garbage, and wrong shapes", () => {
        expect(parseSentryWebhook(hdrs("issue"), sample, at)).toEqual({
            type: "ignored",
            reason: "unsupported_resource:issue",
        });
        expect(parseSentryWebhook(new Headers(), sample, at).type).toBe("ignored");
        expect(parseSentryWebhook(hdrs(), new TextEncoder().encode("{nope"), at)).toEqual({
            type: "ignored",
            reason: "invalid_json",
        });
        expect(parseSentryWebhook(hdrs(), new TextEncoder().encode("{}"), at).type).toBe("ignored");
    });
});
describe("createSentryIssueEnricher", () => {
    const base = "https://sentry.io";
    const eventFrom = (body) => {
        const r = parseSentryWebhook(hdrs(), body, at);
        if (r.type !== "event")
            throw new Error("expected event");
        return r.event;
    };
    const issueResponse = () => Response.json({
        count: "150",
        firstSeen: "2018-11-06T21:19:55Z",
        lastSeen: "2018-12-06T21:19:55Z",
        permalink: "https://sentry.io/x/y/issues/1/",
    });
    test("fills issue stats with the bearer token", async () => {
        const calls = [];
        const mock = (async (url, init) => {
            calls.push({ url, init });
            return issueResponse();
        });
        const enrich = createSentryIssueEnricher({ apiBaseUrl: base, authToken: "tok", fetch: mock });
        const out = await enrich(eventFrom(sample));
        expect(isSentryIssueAlert(out) && out.payload.issue).toEqual({
            count: 150,
            firstSeen: "2018-11-06T21:19:55Z",
            lastSeen: "2018-12-06T21:19:55Z",
            permalink: "https://sentry.io/x/y/issues/1/",
        });
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe("https://sentry.io/api/0/issues/1117540176/");
        expect(calls[0].init.headers.Authorization).toBe("Bearer tok");
        expect(calls[0].init.signal).toBeDefined();
    });
    test("never fetches another host", async () => {
        let called = 0;
        const mock = (async () => {
            called++;
            return issueResponse();
        });
        const enrich = createSentryIssueEnricher({ apiBaseUrl: base, authToken: "tok", fetch: mock });
        const body = new TextEncoder().encode(new TextDecoder()
            .decode(sample)
            .replace("https://sentry.io/api/0/issues/", "https://evil.example.com/api/0/issues/"));
        const ev = eventFrom(body);
        expect(await enrich(ev)).toBe(ev);
        const lookalike = new TextEncoder().encode(new TextDecoder()
            .decode(sample)
            .replace("https://sentry.io/api/0/issues/", "https://sentry.io.evil.com/api/0/issues/"));
        const ev2 = eventFrom(lookalike);
        expect(await enrich(ev2)).toBe(ev2);
        expect(called).toBe(0);
    });
    test("no token means no fetch", async () => {
        let called = 0;
        const mock = (async () => {
            called++;
            return issueResponse();
        });
        const enrich = createSentryIssueEnricher({ apiBaseUrl: base, fetch: mock });
        const ev = eventFrom(sample);
        expect(await enrich(ev)).toBe(ev);
        expect(called).toBe(0);
    });
    test("500, network error, and bad body return the event unchanged", async () => {
        const ev = eventFrom(sample);
        for (const impl of [
            async () => new Response("boom", { status: 500 }),
            async () => {
                throw new DOMException("timed out", "TimeoutError");
            },
            async () => Response.json({ nope: true }),
        ]) {
            const enrich = createSentryIssueEnricher({
                apiBaseUrl: base,
                authToken: "tok",
                fetch: impl,
            });
            expect(await enrich(ev)).toBe(ev);
        }
    });
});
describe("createSentrySource", () => {
    test("verifies, parses, and only exposes enrich when configured", () => {
        const source = createSentrySource({ clientSecret: secret });
        expect(source.name).toBe("sentry");
        expect(source.enrich).toBeUndefined();
        const headers = new Headers({
            "sentry-hook-resource": "event_alert",
            "sentry-hook-signature": sign(sample),
        });
        expect(source.verify({ headers, rawBody: sample })).toBe(true);
        expect(source.parse({ headers, rawBody: sample }, at).type).toBe("event");
        expect(createSentrySource({ clientSecret: secret, apiBaseUrl: "https://sentry.io", authToken: "t" })
            .enrich).toBeDefined();
    });
});

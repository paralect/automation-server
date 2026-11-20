import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { createSlackSource, parseSlackWebhook, verifySlackSignature } from "../src";
const bytes = (s) => new TextEncoder().encode(s);
const SECRET = "slack-signing-secret";
const NOW_S = 1_800_000_000;
const NOW_MS = NOW_S * 1000;
const at = new Date("2026-01-01T00:00:00Z");
const sign = (body, ts, key = SECRET) => `v0=${createHmac("sha256", key).update(`v0:${ts}:`).update(body).digest("hex")}`;
const signedRequest = (body, { ts = NOW_S, key = SECRET } = {}) => ({
    headers: new Headers({ "x-slack-request-timestamp": String(ts), "x-slack-signature": sign(body, ts, key) }),
    rawBody: body,
});
const mention = (patch = {}, top = {}) => ({
    type: "event_callback",
    team_id: "T1",
    event_id: "Ev1",
    authorizations: [{ user_id: "UBOT" }],
    event: { type: "app_mention", user: "U1", text: "<@UBOT> create a ticket", ts: "1700000000.000100", channel: "C1", ...patch },
    ...top,
});
describe("slack signature", () => {
    const body = bytes(JSON.stringify(mention()));
    const source = createSlackSource({ signingSecret: SECRET, now: () => NOW_MS });
    test("accepts a valid v0 signature", () => {
        expect(source.verify(signedRequest(body))).toBe(true);
    });
    test("rejects a wrong secret, tampered body and wrong version prefix", () => {
        expect(source.verify(signedRequest(body, { key: "other" }))).toBe(false);
        const request = signedRequest(body);
        expect(source.verify({ ...request, rawBody: bytes(`${JSON.stringify(mention())} `) })).toBe(false);
        const wrongVersion = new Headers(request.headers);
        wrongVersion.set("x-slack-signature", request.headers.get("x-slack-signature").replace("v0=", "v1="));
        expect(source.verify({ ...request, headers: wrongVersion })).toBe(false);
    });
    test("rejects missing headers", () => {
        const request = signedRequest(body);
        const noSig = new Headers(request.headers);
        noSig.delete("x-slack-signature");
        const noTs = new Headers(request.headers);
        noTs.delete("x-slack-request-timestamp");
        expect(source.verify({ ...request, headers: noSig })).toBe(false);
        expect(source.verify({ ...request, headers: noTs })).toBe(false);
        expect(source.verify({ ...request, headers: new Headers() })).toBe(false);
    });
    test("rejects a malformed timestamp even when it is signed", () => {
        const ts = "12abc";
        const headers = new Headers({ "x-slack-request-timestamp": ts, "x-slack-signature": sign(body, ts) });
        expect(source.verify({ headers, rawBody: body })).toBe(false);
    });
    test("replay window is five minutes in both directions", () => {
        const at = (offsetS) => verifySlackSignature(body, signedRequest(body).headers, SECRET, NOW_MS + offsetS * 1000);
        expect(at(299)).toBe(true);
        expect(at(301)).toBe(false);
        expect(at(-299)).toBe(true);
        expect(at(-301)).toBe(false);
    });
    test("a stale but correctly signed request is rejected", () => {
        const stale = signedRequest(body, { ts: NOW_S - 600 });
        expect(source.verify(stale)).toBe(false);
    });
    test("an empty signing secret never verifies", () => {
        const empty = createSlackSource({ signingSecret: "", now: () => NOW_MS });
        expect(empty.verify(signedRequest(body, { key: "" }))).toBe(false);
    });
});
describe("slack respond", () => {
    const source = createSlackSource({ signingSecret: SECRET, now: () => NOW_MS });
    const challenge = bytes(JSON.stringify({ type: "url_verification", challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P", token: "legacy" }));
    test("answers url_verification with the challenge", () => {
        expect(source.respond(signedRequest(challenge))).toEqual({ body: { challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" } });
    });
    test("does not answer events or garbage", () => {
        expect(source.respond(signedRequest(bytes(JSON.stringify(mention()))))).toBeUndefined();
        expect(source.respond(signedRequest(bytes("not json")))).toBeUndefined();
    });
});
describe("parseSlackWebhook", () => {
    const eventOf = (body) => {
        const result = parseSlackWebhook(bytes(JSON.stringify(body)), at);
        if (result.type !== "event")
            throw new Error(`expected event, got ${result.reason}`);
        return result.event;
    };
    const reasonOf = (body) => {
        const result = parseSlackWebhook(bytes(JSON.stringify(body)), at);
        if (result.type !== "ignored")
            throw new Error("expected ignored");
        return result.reason;
    };
    test("maps app_mention to the event shape with the leading mention stripped", () => {
        expect(eventOf(mention())).toEqual({
            source: "slack",
            kind: "app_mention",
            externalId: "Ev1",
            receivedAt: at.toISOString(),
            payload: { team: "T1", channel: "C1", user: "U1", text: "create a ticket", ts: "1700000000.000100", threadTs: null },
        });
    });
    test("keeps the thread root and later mentions in the text", () => {
        const event = eventOf(mention({ thread_ts: "1700000000.000001", text: "<@UBOT>: tell <@U2> hi" }));
        expect(event.payload).toMatchObject({ threadTs: "1700000000.000001", text: "tell <@U2> hi" });
    });
    test("ignores bot-authored events", () => {
        expect(reasonOf(mention({ bot_id: "B1" }))).toBe("bot_author");
        expect(reasonOf(mention({ subtype: "bot_message" }))).toBe("bot_author");
        expect(reasonOf(mention({ user: "UBOT" }))).toBe("bot_author");
    });
    test("ignores other event types, envelopes and garbage", () => {
        expect(reasonOf(mention({ type: "message" }))).toBe("unsupported_event:message");
        expect(reasonOf({ type: "url_verification", challenge: "c" })).toBe("unsupported_type:url_verification");
        expect(reasonOf({ nope: 1 })).toBe("invalid_payload_shape");
        expect(parseSlackWebhook(bytes("{"), at)).toEqual({ type: "ignored", reason: "invalid_json" });
    });
    test("an event without an event_id is ignored", () => {
        expect(reasonOf(mention({}, { event_id: undefined }))).toBe("invalid_payload_shape");
    });
});

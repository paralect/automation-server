import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { createLinearSource, parseLinearWebhook, verifyLinearSignature } from "../src";
const bytes = (s) => new TextEncoder().encode(s);
const base = JSON.parse(readFileSync(new URL("./fixtures/linear-issue-label-added.json", import.meta.url), "utf8"));
const NOW = base.webhookTimestamp;
const secret = "lin_wh_secret";
const sign = (body, key = secret) => createHmac("sha256", key).update(body).digest("hex");
const at = new Date("2026-01-01T00:00:00Z");
const withData = (patch, top = {}) => bytes(JSON.stringify({ ...base, ...top, data: { ...base.data, ...patch } }));
const request = (body, signature = sign(body)) => ({
    headers: new Headers(signature === null ? {} : { "linear-signature": signature }),
    rawBody: body,
});
describe("linear signature and freshness", () => {
    const body = bytes(JSON.stringify(base));
    const source = createLinearSource({ webhookSecret: secret, now: () => NOW });
    test("accepts a valid signature within the window", () => {
        expect(source.verify(request(body))).toBe(true);
    });
    test("rejects a tampered body", () => {
        const tampered = body.slice();
        tampered[20] = tampered[20] ^ 1;
        expect(source.verify(request(tampered, sign(body)))).toBe(false);
    });
    test("rejects a missing, malformed or wrong-secret signature", () => {
        expect(source.verify(request(body, null))).toBe(false);
        expect(source.verify(request(body, "zz"))).toBe(false);
        expect(source.verify(request(body, sign(body, "other")))).toBe(false);
        expect(verifyLinearSignature(body, sign(body, ""), "")).toBe(false);
    });
    test("rejects a stale or future timestamp, accepts 59 s", () => {
        const late = createLinearSource({ webhookSecret: secret, now: () => NOW + 61_000 });
        expect(late.verify(request(body))).toBe(false);
        const early = createLinearSource({ webhookSecret: secret, now: () => NOW - 61_000 });
        expect(early.verify(request(body))).toBe(false);
        const ok = createLinearSource({ webhookSecret: secret, now: () => NOW + 59_000 });
        expect(ok.verify(request(body))).toBe(true);
    });
    test("rejects a correctly signed body without webhookTimestamp", () => {
        const { webhookTimestamp: _drop, ...rest } = base;
        const noTs = bytes(JSON.stringify(rest));
        expect(source.verify(request(noTs))).toBe(false);
    });
});
describe("parseLinearWebhook", () => {
    const eventOf = (body) => {
        const r = parseLinearWebhook(body, at);
        if (r.type !== "event")
            throw new Error(`expected event, got ${r.reason}`);
        return r.event;
    };
    test("update that adds a label reports only the new label", () => {
        const event = eventOf(bytes(JSON.stringify(base)));
        expect(event).toMatchObject({ source: "linear", kind: "issue" });
        expect(event.externalId).toBe("issue-1:l-codex@2026-01-01T00:00:00.000Z");
        expect(event.payload).toMatchObject({
            identifier: "ENG-42",
            teamKey: "ENG",
            addedLabelIds: ["l-codex"],
            url: "https://linear.app/acme/issue/ENG-42/fix-login",
        });
    });
    test("update where the label was already present is ignored", () => {
        const body = withData({ title: "renamed" }, { updatedFrom: { labelIds: ["l-bug", "l-codex"] } });
        expect(parseLinearWebhook(body, at)).toEqual({ type: "ignored", reason: "no_label_added" });
    });
    test("update that did not touch labels is ignored", () => {
        const body = bytes(JSON.stringify({ ...base, updatedFrom: { title: "old" } }));
        expect(parseLinearWebhook(body, at)).toEqual({ type: "ignored", reason: "labels_unchanged" });
    });
    test("create with labels counts every label as added", () => {
        const body = bytes(JSON.stringify({ ...base, action: "create", updatedFrom: undefined }));
        const event = eventOf(body);
        expect(event.payload).toMatchObject({ action: "create", addedLabelIds: ["l-bug", "l-codex"] });
        expect(event.externalId).toBe("issue-1:l-bug+l-codex@2026-01-01T00:00:00.000Z");
    });
    test("create without labels is ignored", () => {
        const body = withData({ labelIds: [], labels: [] }, { action: "create", updatedFrom: undefined });
        expect(parseLinearWebhook(body, at).type).toBe("ignored");
    });
    test("a later re-add of the same label is a different claim", () => {
        const first = eventOf(bytes(JSON.stringify(base)));
        const again = eventOf(withData({ updatedAt: "2026-01-02T00:00:00.000Z" }));
        expect(again.externalId).not.toBe(first.externalId);
        expect(eventOf(bytes(JSON.stringify(base))).externalId).toBe(first.externalId);
    });
    test("unrelated types and actions are ignored", () => {
        expect(parseLinearWebhook(bytes(JSON.stringify({ ...base, type: "Comment" })), at)).toEqual({ type: "ignored", reason: "unsupported_type:Comment" });
        expect(parseLinearWebhook(bytes(JSON.stringify({ ...base, action: "remove" })), at)).toEqual({ type: "ignored", reason: "unsupported_action:remove" });
    });
    test("invalid json and shape are ignored", () => {
        expect(parseLinearWebhook(bytes("nope"), at)).toEqual({ type: "ignored", reason: "invalid_json" });
        expect(parseLinearWebhook(bytes("{}"), at)).toEqual({ type: "ignored", reason: "invalid_payload_shape" });
    });
});

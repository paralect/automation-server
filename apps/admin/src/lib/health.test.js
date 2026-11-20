import { describe, expect, test } from "bun:test";
import { expiryLabel, expiryState, healthDot } from "./health";
const NOW = new Date("2026-11-17T06:00:00Z");
const inDays = (days) => new Date(NOW.getTime() + days * 86_400_000).toISOString();
describe("expiryState", () => {
    test("no or unparseable expiry is none", () => {
        expect(expiryState(undefined, NOW)).toEqual({ kind: "none" });
        expect(expiryState("soon", NOW)).toEqual({ kind: "none" });
    });
    test("a past or current instant is expired", () => {
        expect(expiryState(inDays(-1), NOW)).toEqual({ kind: "expired" });
        expect(expiryState(NOW.toISOString(), NOW)).toEqual({ kind: "expired" });
    });
    test("days are rounded up and warn at 14 days or fewer", () => {
        expect(expiryState(inDays(5), NOW)).toEqual({ kind: "expiring", days: 5, warning: true });
        expect(expiryState(new Date(NOW.getTime() + 3_600_000).toISOString(), NOW)).toEqual({ kind: "expiring", days: 1, warning: true });
        expect(expiryState(inDays(14), NOW)).toEqual({ kind: "expiring", days: 14, warning: true });
        expect(expiryState(inDays(15), NOW)).toEqual({ kind: "expiring", days: 15, warning: false });
    });
});
describe("labels", () => {
    test("expiryLabel", () => {
        expect(expiryLabel(expiryState(inDays(5), NOW))).toBe("Expires in 5 days");
        expect(expiryLabel(expiryState(inDays(1), NOW))).toBe("Expires in 1 day");
        expect(expiryLabel(expiryState(inDays(-3), NOW))).toBe("Expired");
        expect(expiryLabel({ kind: "none" })).toBeUndefined();
    });
    test("healthDot", () => {
        expect(healthDot(undefined)).toBe("unknown");
        expect(healthDot({ checkedAt: "x", ok: true, message: "" })).toBe("ok");
        expect(healthDot({ checkedAt: "x", ok: false, message: "" })).toBe("failed");
    });
});

import { describe, expect, test } from "bun:test";
import { resolveClientIp } from "./client-ip.server";
describe("resolveClientIp", () => {
    test("ignores X-Forwarded-For unless the proxy is trusted", () => {
        expect(resolveClientIp({ forwardedFor: "1.1.1.1", socketIp: "9.9.9.9", trustProxy: false })).toBe("9.9.9.9");
    });
    test("falls back to unknown without a socket address", () => {
        expect(resolveClientIp({ forwardedFor: "1.1.1.1", socketIp: null, trustProxy: false })).toBe("unknown");
    });
    test("takes the last hop when trusted, so a spoofed prefix cannot rotate the key", () => {
        expect(resolveClientIp({ forwardedFor: "6.6.6.6, 7.7.7.7, 2.2.2.2", socketIp: "10.0.0.1", trustProxy: true })).toBe("2.2.2.2");
    });
    test("uses the socket address when trusted but the header is absent or empty", () => {
        expect(resolveClientIp({ forwardedFor: null, socketIp: "10.0.0.1", trustProxy: true })).toBe("10.0.0.1");
        expect(resolveClientIp({ forwardedFor: " ", socketIp: "10.0.0.1", trustProxy: true })).toBe("10.0.0.1");
    });
});

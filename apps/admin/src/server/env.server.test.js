import { describe, expect, test } from "bun:test";
import { parseEnv } from "./env.server";
const base = {
    AUTOMATION_SERVER_URL: "http://localhost:3000",
    ADMIN_API_TOKEN: "t",
    ADMIN_EMAIL: "Admin@Example.com",
    ADMIN_PASSWORD: "p",
    SESSION_SECRET: "x".repeat(32),
};
describe("parseEnv", () => {
    test("keeps a valid ADMIN_EMAIL byte for byte", () => {
        expect(parseEnv(base).ADMIN_EMAIL).toBe("Admin@Example.com");
    });
    test("rejects an ADMIN_EMAIL that is not an email", () => {
        expect(() => parseEnv({ ...base, ADMIN_EMAIL: "admin" })).toThrow(/ADMIN_EMAIL/);
    });
    test("TRUST_PROXY defaults to false and parses true", () => {
        expect(parseEnv(base).TRUST_PROXY).toBe(false);
        expect(parseEnv({ ...base, TRUST_PROXY: "true" }).TRUST_PROXY).toBe(true);
    });
});

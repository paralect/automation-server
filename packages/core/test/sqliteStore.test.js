import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStore } from "../src/sqliteStore";
const open = [];
const track = (s) => (open.push(s), s);
afterEach(() => {
    while (open.length)
        open.pop().close();
});
describe("sqlite claim store", () => {
    test("claim is true once, then false", () => {
        const s = track(createSqliteStore({ path: ":memory:" }));
        expect(s.claim("a")).toBe(true);
        expect(s.claim("a")).toBe(false);
        expect(s.claim("b")).toBe(true);
    });
    test("release lets the key be claimed again", () => {
        const s = track(createSqliteStore({ path: ":memory:" }));
        s.claim("a");
        s.release("a");
        expect(s.claim("a")).toBe(true);
    });
    test("complete keeps the key blocked, even after release and lease expiry", () => {
        let t = 0;
        const s = track(createSqliteStore({ path: ":memory:", leaseMs: 10, now: () => t }));
        s.claim("a");
        s.complete("a");
        s.release("a");
        t = 1_000;
        expect(s.claim("a")).toBe(false);
    });
    test("stale pending claim is reclaimable after the lease, live one is not", () => {
        let t = 0;
        const s = track(createSqliteStore({ path: ":memory:", leaseMs: 100, now: () => t }));
        expect(s.claim("a")).toBe(true);
        t = 99;
        expect(s.claim("a")).toBe(false);
        t = 100;
        expect(s.claim("a")).toBe(true);
        t = 150;
        expect(s.claim("a")).toBe(false);
    });
    test("two instances on one file see each other's claims", () => {
        const dir = mkdtempSync(join(tmpdir(), "claims-"));
        try {
            const path = join(dir, "nested", "claims.db");
            const a = track(createSqliteStore({ path }));
            const b = track(createSqliteStore({ path }));
            expect(a.claim("k")).toBe(true);
            expect(b.claim("k")).toBe(false);
            a.complete("k");
            expect(b.claim("k")).toBe(false);
            expect(b.claim("other")).toBe(true);
            expect(a.claim("other")).toBe(false);
        }
        finally {
            while (open.length)
                open.pop().close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

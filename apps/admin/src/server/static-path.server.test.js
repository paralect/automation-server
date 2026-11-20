import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveStaticPath } from "./static-path.server";
const root = join("/srv", "client");
describe("resolveStaticPath", () => {
    test("resolves a normal asset", () => {
        expect(resolveStaticPath(root, "/assets/app.js")).toEqual({ kind: "ok", path: join(root, "assets/app.js") });
    });
    test("decodes percent escapes", () => {
        expect(resolveStaticPath(root, "/a%20b.png")).toEqual({ kind: "ok", path: join(root, "a b.png") });
    });
    test("rejects a malformed escape with bad-request instead of throwing", () => {
        expect(resolveStaticPath(root, "/%E0%A4%A")).toEqual({ kind: "bad-request" });
        expect(resolveStaticPath(root, "/%")).toEqual({ kind: "bad-request" });
    });
    test("rejects NUL bytes", () => {
        expect(resolveStaticPath(root, "/a%00b")).toEqual({ kind: "bad-request" });
    });
    test("never resolves outside the root", () => {
        for (const p of ["/../etc/passwd", "/%2e%2e/etc/passwd", "/..%2f..%2fetc/passwd", "/%2e%2e%2f%2e%2e%2fsecret", "/", "//"]) {
            const result = resolveStaticPath(root, p);
            if (result.kind === "ok")
                expect(result.path.startsWith(root + "/")).toBe(true);
        }
        expect(resolveStaticPath(root, "/%2e%2e%2fsecret").kind).toBe("none");
    });
});

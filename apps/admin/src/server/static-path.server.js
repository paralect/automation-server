import { join, sep } from "node:path";
export function resolveStaticPath(rootDir, pathname) {
    let decoded;
    try {
        decoded = decodeURIComponent(pathname);
    }
    catch {
        return { kind: "bad-request" };
    }
    if (decoded.includes("\0"))
        return { kind: "bad-request" };
    const path = join(rootDir, decoded);
    if (!path.startsWith(rootDir + sep))
        return { kind: "none" };
    return { kind: "ok", path };
}

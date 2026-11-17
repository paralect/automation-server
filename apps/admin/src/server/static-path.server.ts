import { join, sep } from "node:path"

export type StaticPath = { kind: "ok"; path: string } | { kind: "bad-request" } | { kind: "none" }

export function resolveStaticPath(rootDir: string, pathname: string): StaticPath {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return { kind: "bad-request" }
  }
  if (decoded.includes("\0")) return { kind: "bad-request" }
  const path = join(rootDir, decoded)
  if (!path.startsWith(rootDir + sep)) return { kind: "none" }
  return { kind: "ok", path }
}

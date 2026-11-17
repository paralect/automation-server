import { join } from "node:path"

import app from "./dist/server/server.js"
import { CLIENT_IP_HEADER, resolveClientIp } from "./src/server/client-ip.server"
import { env } from "./src/server/env.server"
import { resolveStaticPath } from "./src/server/static-path.server"

// Fail at startup, not at the first login, so a deploy with a missing secret never turns healthy.
env()

const clientDir = join(import.meta.dir, "dist/client")
const port = Number(process.env.PORT ?? 3001)

Bun.serve({
  port,
  async fetch(request, server) {
    const { pathname } = new URL(request.url)
    if (pathname === "/health") return Response.json({ status: "ok" })
    const resolved = resolveStaticPath(clientDir, pathname)
    if (resolved.kind === "bad-request") return new Response("Bad request", { status: 400 })
    if (resolved.kind === "ok") {
      const file = Bun.file(resolved.path)
      if (await file.exists()) {
        return new Response(file, {
          headers: pathname.startsWith("/assets/")
            ? { "Cache-Control": "public, max-age=31536000, immutable" }
            : {},
        })
      }
    }
    const headers = new Headers(request.headers)
    headers.set(
      CLIENT_IP_HEADER,
      resolveClientIp({
        forwardedFor: request.headers.get("x-forwarded-for"),
        socketIp: server.requestIP(request)?.address ?? null,
        trustProxy: env().TRUST_PROXY,
      })
    )
    return app.fetch(new Request(request, { headers }))
  },
})

console.log(`admin listening on http://localhost:${port}`)

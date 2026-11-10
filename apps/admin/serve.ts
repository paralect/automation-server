import { join, sep } from "node:path"

import app from "./dist/server/server.js"

const clientDir = join(import.meta.dir, "dist/client")
const port = Number(process.env.PORT ?? 3001)

Bun.serve({
  port,
  async fetch(request) {
    const { pathname } = new URL(request.url)
    const path = join(clientDir, pathname)
    if (path.startsWith(clientDir + sep)) {
      const file = Bun.file(path)
      if (await file.exists()) {
        return new Response(file, {
          headers: pathname.startsWith("/assets/")
            ? { "Cache-Control": "public, max-age=31536000, immutable" }
            : {},
        })
      }
    }
    return app.fetch(request)
  },
})

console.log(`admin listening on http://localhost:${port}`)

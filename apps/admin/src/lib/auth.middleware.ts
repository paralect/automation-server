import { createMiddleware } from "@tanstack/react-start"

import { readSession } from "@/server/session.server"

export const requireAuth = createMiddleware({ type: "function" }).server(({ next }) => {
  if (!readSession()) throw new Error("UNAUTHENTICATED")
  return next()
})

import { createServerFn } from "@tanstack/react-start"
import { getRequestIP } from "@tanstack/react-start/server"
import { z } from "zod"

import {
  clearFailures,
  credentialsMatch,
  isBlocked,
  recordFailure,
} from "@/server/login-guard.server"
import { rememberedProject } from "@/server/project.server"
import { endSession, readSession, startSession } from "@/server/session.server"

/** The session, plus the project the admin last selected so the layout opens on it. */
export const getSessionFn = createServerFn({ method: "GET" }).handler(() => {
  const session = readSession()
  return session ? { ...session, project: rememberedProject() } : null
})

export const loginFn = createServerFn({ method: "POST" })
  .validator(z.object({ email: z.string().max(320), password: z.string().max(1024) }))
  .handler(({ data }): { ok: true } | { ok: false; error: string } => {
    const ip = getRequestIP({ xForwardedFor: true }) ?? "unknown"
    if (isBlocked(ip)) {
      return { ok: false, error: "Too many failed attempts. Try again in 15 minutes." }
    }
    if (!credentialsMatch(data.email.trim(), data.password)) {
      recordFailure(ip)
      return { ok: false, error: "Invalid email or password" }
    }
    clearFailures(ip)
    startSession(data.email.trim())
    return { ok: true }
  })

export const logoutFn = createServerFn({ method: "POST" }).handler(() => {
  endSession()
})

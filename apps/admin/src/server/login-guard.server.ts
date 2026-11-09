import { createHash, timingSafeEqual } from "node:crypto"

import { env } from "./env.server"

const MAX_FAILURES = 5
const WINDOW_MS = 15 * 60 * 1000

const failures = new Map<string, { count: number; resetAt: number }>()

const digest = (value: string) => createHash("sha256").update(value).digest()

export function credentialsMatch(email: string, password: string) {
  const emailOk = timingSafeEqual(digest(email), digest(env().ADMIN_EMAIL))
  const passwordOk = timingSafeEqual(digest(password), digest(env().ADMIN_PASSWORD))
  return emailOk && passwordOk
}

export function isBlocked(ip: string) {
  const entry = failures.get(ip)
  if (!entry) return false
  if (entry.resetAt <= Date.now()) {
    failures.delete(ip)
    return false
  }
  return entry.count >= MAX_FAILURES
}

export function recordFailure(ip: string) {
  const now = Date.now()
  const entry = failures.get(ip)
  if (!entry || entry.resetAt <= now) {
    failures.set(ip, { count: 1, resetAt: now + WINDOW_MS })
    return
  }
  entry.count += 1
}

export function clearFailures(ip: string) {
  failures.delete(ip)
}

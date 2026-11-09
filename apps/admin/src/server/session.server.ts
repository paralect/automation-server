import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { deleteCookie, getCookie, setCookie } from "@tanstack/react-start/server"

import { env } from "./env.server"

const COOKIE = "admin_session"
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7

export type Session = { email: string }

const key = () => createHash("sha256").update(env().SESSION_SECRET).digest()

function seal(payload: Session & { exp: number }) {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key(), iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")
}

function unseal(value: string): (Session & { exp: number }) | null {
  try {
    const raw = Buffer.from(value, "base64url")
    const decipher = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12))
    decipher.setAuthTag(raw.subarray(12, 28))
    const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")
    const payload = JSON.parse(json) as Session & { exp: number }
    return payload.exp > Date.now() ? payload : null
  } catch {
    return null
  }
}

export function readSession(): Session | null {
  const value = getCookie(COOKIE)
  const payload = value ? unseal(value) : null
  return payload ? { email: payload.email } : null
}

export function startSession(email: string) {
  setCookie(COOKIE, seal({ email, exp: Date.now() + MAX_AGE_SECONDS * 1000 }), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  })
}

export function endSession() {
  deleteCookie(COOKIE, { path: "/" })
}

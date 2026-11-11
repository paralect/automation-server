import { getCookie, setCookie } from "@tanstack/react-start/server"

const COOKIE = "admin_project"
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365

/** The project the admin last selected. Only a hint: the layout falls back to the first project when it is gone. */
export function rememberedProject(): string | null {
  const value = getCookie(COOKIE)
  return value && /^[a-z0-9-]{1,64}$/.test(value) ? value : null
}

export function rememberProject(project: string) {
  setCookie(COOKIE, project, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  })
}

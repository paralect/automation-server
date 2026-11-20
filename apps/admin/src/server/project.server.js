import { getCookie, setCookie } from "@tanstack/react-start/server";
const COOKIE = "admin_project";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
export function rememberedProject() {
    const value = getCookie(COOKIE);
    return value && /^[a-z0-9-]{1,64}$/.test(value) ? value : null;
}
export function rememberProject(project) {
    setCookie(COOKIE, project, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: MAX_AGE_SECONDS,
    });
}

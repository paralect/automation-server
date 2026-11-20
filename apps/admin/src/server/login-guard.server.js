import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "./env.server";
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;
const failures = new Map();
const digest = (value) => createHash("sha256").update(value).digest();
export function credentialsMatch(email, password) {
    const emailOk = timingSafeEqual(digest(email), digest(env().ADMIN_EMAIL));
    const passwordOk = timingSafeEqual(digest(password), digest(env().ADMIN_PASSWORD));
    return emailOk && passwordOk;
}
export function isBlocked(ip) {
    const entry = failures.get(ip);
    if (!entry)
        return false;
    if (entry.resetAt <= Date.now()) {
        failures.delete(ip);
        return false;
    }
    return entry.count >= MAX_FAILURES;
}
export function recordFailure(ip) {
    const now = Date.now();
    for (const [key, value] of failures)
        if (value.resetAt <= now)
            failures.delete(key);
    const entry = failures.get(ip);
    if (!entry || entry.resetAt <= now) {
        failures.set(ip, { count: 1, resetAt: now + WINDOW_MS });
        return;
    }
    entry.count += 1;
}
export function clearFailures(ip) {
    failures.delete(ip);
}

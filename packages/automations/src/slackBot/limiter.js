export const RATE_LIMITED_REPLY = "You are sending requests too fast, wait a minute.";
export const BUSY_REPLY = "I am busy, try again in a minute.";
const MINUTE_MS = 60_000;
const DENIAL_WINDOW_MS = 10 * MINUTE_MS;
const BUCKET_SIZE = 6;
const MAX_IN_FLIGHT = 4;
const MAX_TRACKED = 5_000;
// Insertion order doubles as recency order, so a touched key is moved to the end and the oldest keys sit at the front.
function bounded(max, isStale) {
    const map = new Map();
    return {
        get: (key) => map.get(key),
        set(key, value, now) {
            map.delete(key);
            map.set(key, value);
            if (map.size <= max)
                return;
            for (const [k, v] of map)
                if (isStale(v, now))
                    map.delete(k);
            for (const k of map.keys()) {
                if (map.size <= max)
                    break;
                map.delete(k);
            }
        },
    };
}
const REQUEST_COST_MS = MINUTE_MS / BUCKET_SIZE;
export function createSlackBotLimiter({ now = Date.now, denialReply, maxTracked = MAX_TRACKED }) {
    const buckets = bounded(maxTracked, (b, t) => t - b.at >= MINUTE_MS);
    // The time a notice was last sent per key. A notice is allowed again after its window.
    const denials = bounded(maxTracked, (at, t) => t - at >= DENIAL_WINDOW_MS);
    const notices = bounded(maxTracked, (at, t) => t - at >= MINUTE_MS);
    const inFlight = new Map();
    const noticeDue = (store, key, windowMs, t) => {
        const last = store.get(key);
        if (last !== undefined && t - last < windowMs)
            return false;
        store.set(key, t, t);
        return true;
    };
    const take = (key, t) => {
        const bucket = buckets.get(key) ?? { credit: MINUTE_MS, at: t };
        const credit = Math.min(MINUTE_MS, bucket.credit + Math.max(0, t - bucket.at));
        const allowed = credit >= REQUEST_COST_MS;
        buckets.set(key, { credit: allowed ? credit - REQUEST_COST_MS : credit, at: t }, t);
        return allowed;
    };
    return {
        admit({ project, user, allowed }) {
            const t = now();
            const key = `${project}\u0000${user}`;
            if (!allowed)
                return { kind: "denied", reply: noticeDue(denials, key, DENIAL_WINDOW_MS, t) ? denialReply : null };
            if ((inFlight.get(project) ?? 0) >= MAX_IN_FLIGHT) {
                return { kind: "busy", reply: noticeDue(notices, `busy\u0000${key}`, MINUTE_MS, t) ? BUSY_REPLY : null };
            }
            if (!take(key, t))
                return { kind: "rate-limited", reply: noticeDue(notices, `rate\u0000${key}`, MINUTE_MS, t) ? RATE_LIMITED_REPLY : null };
            inFlight.set(project, (inFlight.get(project) ?? 0) + 1);
            let released = false;
            return {
                kind: "run",
                release() {
                    if (released)
                        return;
                    released = true;
                    const left = (inFlight.get(project) ?? 1) - 1;
                    if (left <= 0)
                        inFlight.delete(project);
                    else
                        inFlight.set(project, left);
                },
            };
        },
    };
}

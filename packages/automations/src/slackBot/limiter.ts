export const RATE_LIMITED_REPLY = "You are sending requests too fast, wait a minute.";
export const BUSY_REPLY = "I am busy, try again in a minute.";

const MINUTE_MS = 60_000;
const DENIAL_WINDOW_MS = 10 * MINUTE_MS;
const BUCKET_SIZE = 6;
const MAX_IN_FLIGHT = 4;
const MAX_TRACKED = 5_000;

export type Admission =
  | { readonly kind: "run"; release(): void }
  | { readonly kind: "denied"; readonly reply: string | null }
  | { readonly kind: "rate-limited"; readonly reply: string | null }
  | { readonly kind: "busy"; readonly reply: string | null };

export type LimiterOptions = {
  readonly now?: () => number;
  readonly denialReply: string;
  readonly maxTracked?: number;
};

export type SlackBotLimiter = {
  admit(input: { project: string; user: string; allowed: boolean }): Admission;
};

// Insertion order doubles as recency order, so a touched key is moved to the end and the oldest keys sit at the front.
function bounded<V>(max: number, isStale: (value: V, now: number) => boolean) {
  const map = new Map<string, V>();
  return {
    get: (key: string) => map.get(key),
    set(key: string, value: V, now: number) {
      map.delete(key);
      map.set(key, value);
      if (map.size <= max) return;
      for (const [k, v] of map) if (isStale(v, now)) map.delete(k);
      for (const k of map.keys()) {
        if (map.size <= max) break;
        map.delete(k);
      }
    },
  };
}

// Credit is counted in milliseconds of refill, so the math stays in integers: a request costs a sixth of a minute and one millisecond earns one back.
type Bucket = { credit: number; at: number };

const REQUEST_COST_MS = MINUTE_MS / BUCKET_SIZE;

export function createSlackBotLimiter({ now = Date.now, denialReply, maxTracked = MAX_TRACKED }: LimiterOptions): SlackBotLimiter {
  const buckets = bounded<Bucket>(maxTracked, (b, t) => t - b.at >= MINUTE_MS);
  // The time a notice was last sent per key. A notice is allowed again after its window.
  const denials = bounded<number>(maxTracked, (at, t) => t - at >= DENIAL_WINDOW_MS);
  const notices = bounded<number>(maxTracked, (at, t) => t - at >= MINUTE_MS);
  const inFlight = new Map<string, number>();

  const noticeDue = (store: ReturnType<typeof bounded<number>>, key: string, windowMs: number, t: number): boolean => {
    const last = store.get(key);
    if (last !== undefined && t - last < windowMs) return false;
    store.set(key, t, t);
    return true;
  };

  const take = (key: string, t: number): boolean => {
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
      if (!allowed) return { kind: "denied", reply: noticeDue(denials, key, DENIAL_WINDOW_MS, t) ? denialReply : null };

      if ((inFlight.get(project) ?? 0) >= MAX_IN_FLIGHT) {
        return { kind: "busy", reply: noticeDue(notices, `busy\u0000${key}`, MINUTE_MS, t) ? BUSY_REPLY : null };
      }
      if (!take(key, t)) return { kind: "rate-limited", reply: noticeDue(notices, `rate\u0000${key}`, MINUTE_MS, t) ? RATE_LIMITED_REPLY : null };

      inFlight.set(project, (inFlight.get(project) ?? 0) + 1);
      let released = false;
      return {
        kind: "run",
        release() {
          if (released) return;
          released = true;
          const left = (inFlight.get(project) ?? 1) - 1;
          if (left <= 0) inFlight.delete(project);
          else inFlight.set(project, left);
        },
      };
    },
  };
}

export const EXPIRY_WARNING_DAYS = 14;
const DAY_MS = 86_400_000;
export function expiryState(expiresAt, now) {
    const at = expiresAt ? Date.parse(expiresAt) : NaN;
    if (Number.isNaN(at))
        return { kind: "none" };
    const left = at - now.getTime();
    if (left <= 0)
        return { kind: "expired" };
    const days = Math.ceil(left / DAY_MS);
    return { kind: "expiring", days, warning: days <= EXPIRY_WARNING_DAYS };
}
export function expiryLabel(state) {
    if (state.kind === "expired")
        return "Expired";
    if (state.kind === "expiring")
        return `Expires in ${state.days} ${state.days === 1 ? "day" : "days"}`;
    return undefined;
}
export const healthDot = (health) => !health ? "unknown" : health.ok ? "ok" : "failed";

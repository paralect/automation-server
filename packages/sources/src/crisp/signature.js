import { createHmac, timingSafeEqual } from "node:crypto";
export const MAX_CRISP_WEBHOOK_AGE_MS = 5 * 60_000;
// Crisp does not document the digest encoding. Hex is the assumption until a real delivery confirms it.
const SIGNATURE_ENCODING = "hex";
export function verifyCrispSignature(rawBody, timestamp, signature, secret) {
    if (secret === "" || timestamp === null || signature === null)
        return false;
    const expected = createHmac("sha256", secret)
        .update(`[${timestamp.trim()};`)
        .update(rawBody)
        .update("]")
        .digest(SIGNATURE_ENCODING);
    const provided = Buffer.from(signature.trim());
    const wanted = Buffer.from(expected);
    return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}
export function isFreshCrispTimestamp(timestamp, nowMs) {
    if (timestamp === null || !/^\d+$/.test(timestamp.trim()))
        return false;
    const raw = Number(timestamp.trim());
    const ms = raw < 1e12 ? raw * 1000 : raw;
    return Math.abs(nowMs - ms) <= MAX_CRISP_WEBHOOK_AGE_MS;
}

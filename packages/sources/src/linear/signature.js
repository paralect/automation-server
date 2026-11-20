import { createHmac, timingSafeEqual } from "node:crypto";
const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;
export const MAX_WEBHOOK_AGE_MS = 60_000;
export function verifyLinearSignature(rawBody, signatureHex, secret) {
    if (secret === "" || signatureHex === null)
        return false;
    const provided = signatureHex.trim();
    if (!HEX_SHA256.test(provided))
        return false;
    const expected = createHmac("sha256", secret).update(rawBody).digest();
    return timingSafeEqual(expected, Buffer.from(provided, "hex"));
}
export function isFreshLinearWebhook(rawBody, nowMs) {
    let json;
    try {
        json = JSON.parse(new TextDecoder().decode(rawBody));
    }
    catch {
        return false;
    }
    const ts = json?.webhookTimestamp;
    if (typeof ts !== "number" || !Number.isFinite(ts))
        return false;
    return Math.abs(nowMs - ts) <= MAX_WEBHOOK_AGE_MS;
}

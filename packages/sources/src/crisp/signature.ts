import { createHmac, timingSafeEqual, type BinaryToTextEncoding } from "node:crypto";

export const MAX_CRISP_WEBHOOK_AGE_MS = 5 * 60_000;

// Crisp does not document the digest encoding. Hex is the assumption until a real delivery confirms it.
const SIGNATURE_ENCODING: BinaryToTextEncoding = "hex";

/** Crisp signs `[<timestamp>;<raw body>]`, brackets and semicolon included, with HMAC-SHA256. */
export function verifyCrispSignature(
  rawBody: Uint8Array,
  timestamp: string | null,
  signature: string | null,
  secret: string,
): boolean {
  if (secret === "" || timestamp === null || signature === null) return false;
  const expected = createHmac("sha256", secret)
    .update(`[${timestamp.trim()};`)
    .update(rawBody)
    .update("]")
    .digest(SIGNATURE_ENCODING);
  const provided = Buffer.from(signature.trim());
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

/** The timestamp is in milliseconds. A seconds value is accepted too, in case a delivery uses one. */
export function isFreshCrispTimestamp(timestamp: string | null, nowMs: number): boolean {
  if (timestamp === null || !/^\d+$/.test(timestamp.trim())) return false;
  const raw = Number(timestamp.trim());
  const ms = raw < 1e12 ? raw * 1000 : raw;
  return Math.abs(nowMs - ms) <= MAX_CRISP_WEBHOOK_AGE_MS;
}

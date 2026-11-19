import { createHmac, timingSafeEqual } from "node:crypto";

const V0_SIGNATURE = /^v0=[0-9a-fA-F]{64}$/;
const TIMESTAMP = /^\d{1,12}$/;

export const MAX_SLACK_REQUEST_AGE_MS = 5 * 60_000;

export function verifySlackSignature(rawBody: Uint8Array, headers: Headers, signingSecret: string, nowMs: number): boolean {
  const timestamp = headers.get("x-slack-request-timestamp")?.trim() ?? null;
  const signature = headers.get("x-slack-signature")?.trim() ?? null;
  if (signingSecret === "" || timestamp === null || signature === null) return false;
  if (!TIMESTAMP.test(timestamp) || !V0_SIGNATURE.test(signature)) return false;
  if (Math.abs(nowMs - Number(timestamp) * 1000) > MAX_SLACK_REQUEST_AGE_MS) return false;
  const expected = createHmac("sha256", signingSecret).update(`v0:${timestamp}:`).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(3), "hex"));
}

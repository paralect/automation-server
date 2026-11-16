import type { ParseResult } from "@automation-server/core/source";
import { z } from "zod";

import { CRISP_RESOLVED, CRISP_SEGMENTS, CRISP_SOURCE, type CrispSession, type CrispSessionKind } from "./event";

const envelopeSchema = z.object({
  website_id: z.string(),
  event: z.string(),
  data: z.unknown(),
});

const segmentsSchema = z.object({ session_id: z.string().min(1), segments: z.array(z.string()) });
const stateSchema = z.object({ session_id: z.string().min(1), state: z.string() });

const ignored = (reason: string): ParseResult => ({ type: "ignored", reason });

function sessionEvent(kind: CrispSessionKind, payload: CrispSession, receivedAt: Date): ParseResult {
  return {
    type: "event",
    event: {
      source: CRISP_SOURCE,
      kind,
      externalId: `${payload.sessionId}:${kind === CRISP_SEGMENTS ? "triage" : "resolved"}`,
      receivedAt: receivedAt.toISOString(),
      payload,
    },
  };
}

export function parseCrispWebhook(rawBody: Uint8Array, receivedAt: Date, websiteId: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return ignored("invalid_json");
  }
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) return ignored("invalid_payload_shape");
  const { website_id, event, data } = envelope.data;
  if (website_id !== websiteId) return ignored("website_mismatch");

  if (event === "session:set_segments") {
    const parsed = segmentsSchema.safeParse(data);
    if (!parsed.success) return ignored("invalid_payload_shape");
    return sessionEvent(
      CRISP_SEGMENTS,
      { websiteId, sessionId: parsed.data.session_id, segments: parsed.data.segments, request: null },
      receivedAt,
    );
  }
  if (event === "session:set_state") {
    const parsed = stateSchema.safeParse(data);
    if (!parsed.success) return ignored("invalid_payload_shape");
    if (parsed.data.state !== "resolved") return ignored(`unsupported_state:${parsed.data.state}`);
    return sessionEvent(CRISP_RESOLVED, { websiteId, sessionId: parsed.data.session_id, segments: [], request: null }, receivedAt);
  }
  return ignored(`unsupported_event:${event}`);
}

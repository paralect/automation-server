import type { Event } from "@automation-server/core/event";

import type { CrispClient, CrispRawMessage } from "./client";
import { AUTOMATION_NOTE_PREFIX, isCrispSession, type CustomerMessage, type CustomerRequest } from "./event";

function toMessage(m: CrispRawMessage): CustomerMessage | null {
  if (typeof m.content !== "string" || m.content.trim() === "") return null;
  if (m.from !== "user" && m.from !== "operator") return null;
  if (m.type === "note" && m.content.startsWith(AUTOMATION_NOTE_PREFIX)) return null;
  if (m.type !== "text" && m.type !== "note") return null;
  return { from: m.from, at: new Date(m.timestamp).toISOString(), text: m.content };
}

export function createCrispEnricher(client: Pick<CrispClient, "conversation" | "messages">): (event: Event) => Promise<Event> {
  return async (event) => {
    if (!isCrispSession(event)) return event;
    const { sessionId, websiteId } = event.payload;
    const [conversation, raw] = await Promise.all([client.conversation(sessionId), client.messages(sessionId)]);
    const request: CustomerRequest = {
      sessionId,
      websiteId,
      customer: conversation.email ? { email: conversation.email } : {},
      messages: raw
        .toSorted((a, b) => a.timestamp - b.timestamp)
        .map(toMessage)
        .filter((m): m is CustomerMessage => m !== null),
      segments: conversation.segments,
    };
    return { ...event, payload: { ...event.payload, request } };
  };
}

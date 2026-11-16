import type { Event } from "@automation-server/core/event";

export const CRISP_SOURCE = "crisp";
export const CRISP_SEGMENTS = "segments";
export const CRISP_RESOLVED = "resolved";

/** Every note the server writes starts with this, so its own notes are never fed back to the classifier. */
export const AUTOMATION_NOTE_PREFIX = "[automation-server triage]";

export type CustomerMessage = {
  readonly from: "user" | "operator";
  readonly at: string;
  readonly text: string;
};

/** A Crisp conversation as the triage sees it. Built by the source's enrich step from the REST API. */
export type CustomerRequest = {
  readonly sessionId: string;
  readonly websiteId: string;
  /** Server-side only: never sent to the LLM or GitHub. */
  readonly customer: { readonly email?: string };
  readonly messages: readonly CustomerMessage[];
  readonly segments: readonly string[];
};

export type CrispSession = {
  readonly websiteId: string;
  readonly sessionId: string;
  /** Segments carried by a `session:set_segments` delivery. Empty for state changes. */
  readonly segments: readonly string[];
  /** Null until enrich loads the conversation, and when loading it failed. */
  readonly request: CustomerRequest | null;
};

export type CrispSessionKind = typeof CRISP_SEGMENTS | typeof CRISP_RESOLVED;
export type CrispSessionEvent = Event<CrispSession, CrispSessionKind>;

export function isCrispSession(event: Event): event is CrispSessionEvent {
  return event.source === CRISP_SOURCE && (event.kind === CRISP_SEGMENTS || event.kind === CRISP_RESOLVED);
}

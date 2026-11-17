import type { Event } from "@automation-server/core/event";

export const CRISP_SOURCE = "crisp";
export const CRISP_SEGMENTS = "segments";
export const CRISP_RESOLVED = "resolved";

export const AUTOMATION_NOTE_PREFIX = "[automation-server triage]";

export type CustomerMessage = {
  readonly from: "user" | "operator";
  readonly at: string;
  readonly text: string;
};

export type CustomerRequest = {
  readonly sessionId: string;
  readonly websiteId: string;
  readonly customer: { readonly email?: string };
  readonly messages: readonly CustomerMessage[];
  readonly segments: readonly string[];
};

export type CrispSession = {
  readonly websiteId: string;
  readonly sessionId: string;
  readonly segments: readonly string[];
  readonly request: CustomerRequest | null;
};

export type CrispSessionKind = typeof CRISP_SEGMENTS | typeof CRISP_RESOLVED;
export type CrispSessionEvent = Event<CrispSession, CrispSessionKind>;

export function isCrispSession(event: Event): event is CrispSessionEvent {
  return event.source === CRISP_SOURCE && (event.kind === CRISP_SEGMENTS || event.kind === CRISP_RESOLVED);
}

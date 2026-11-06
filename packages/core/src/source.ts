import type { Event } from "./event";

export type WebhookRequest = {
  readonly headers: Headers;
  readonly rawBody: Uint8Array;
};

export type ParseResult =
  | { readonly type: "event"; readonly event: Event }
  | { readonly type: "ignored"; readonly reason: string };

export type Source = {
  readonly name: string;
  verify(request: WebhookRequest): boolean;
  parse(request: WebhookRequest, receivedAt: Date): ParseResult;
  enrich?(event: Event): Promise<Event>;
};

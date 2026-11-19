import type { Event } from "./event";

export type WebhookRequest = {
  readonly headers: Headers;
  readonly rawBody: Uint8Array;
};

export type ParseResult =
  | { readonly type: "event"; readonly event: Event }
  | { readonly type: "ignored"; readonly reason: string };

export type SourceReply = { readonly body: unknown };

export type Source = {
  readonly name: string;
  verify(request: WebhookRequest): boolean;
  // Runs after verify and before parse. A reply answers the request itself and nothing is parsed or dispatched, which is how a handshake like Slack's url_verification is answered.
  respond?(request: WebhookRequest): SourceReply | undefined;
  parse(request: WebhookRequest, receivedAt: Date): ParseResult;
  enrich?(event: Event): Promise<Event>;
};

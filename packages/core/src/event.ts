export type Event<P = unknown, K extends string = string> = {
  /** Project the event was received for. Set by the webhook route, not by the source. */
  readonly project?: string;
  readonly source: string;
  readonly kind: K;
  readonly externalId: string;
  readonly receivedAt: string;
  readonly payload: P;
};

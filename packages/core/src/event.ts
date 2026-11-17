export type Event<P = unknown, K extends string = string> = {
  readonly project?: string;
  readonly source: string;
  readonly kind: K;
  readonly externalId: string;
  readonly receivedAt: string;
  readonly payload: P;
};

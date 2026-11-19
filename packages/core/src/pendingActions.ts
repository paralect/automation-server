export type PendingStatus = "pending" | "approved" | "cancelled" | "expired" | "executed" | "failed";

// A write the bot proposed and a person has not yet approved. `args` are already validated by the tool's schema.
export type PendingAction = {
  readonly id: string;
  readonly project: string;
  readonly team: string;
  readonly channel: string;
  readonly threadTs: string;
  readonly requestedBy: string;
  readonly tool: string;
  readonly args: unknown;
  readonly status: PendingStatus;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly resolvedAt?: number;
  readonly resultText?: string;
};

export type NewPendingAction = Pick<PendingAction, "project" | "team" | "channel" | "threadTs" | "requestedBy" | "tool" | "args" | "expiresAt">;

export const TRANSITIONS: Readonly<Record<PendingStatus, readonly PendingStatus[]>> = {
  pending: ["approved", "cancelled", "expired"],
  approved: ["executed", "failed"],
  cancelled: [],
  expired: [],
  executed: [],
  failed: [],
};

export const canTransition = (from: PendingStatus, to: PendingStatus): boolean => TRANSITIONS[from].includes(to);

export const isTerminal = (status: PendingStatus): boolean => TRANSITIONS[status].length === 0;

export interface PendingActionStore {
  // A thread holds at most one pending action: a new proposal cancels the one before it.
  create(action: NewPendingAction): PendingAction;
  get(id: string): PendingAction | null;
  findPendingForThread(project: string, channel: string, threadTs: string): PendingAction | null;
  // Compare and set. Returns true only for the caller that moved the action out of `from`, so a double approve executes once.
  transition(id: string, from: PendingStatus, to: PendingStatus, resultText?: string): boolean;
  // Marks every still pending action whose expiry has passed. Returns how many.
  expireOlderThan(now: number): number;
  // Deletes finished rows resolved before the cutoff and any row, whatever its status, whose expiry is before it. Returns how many.
  prune(beforeIso: string): number;
  close(): void;
}

import { redactUntrusted, truncate } from "../redact";
import type { SlackThreadMessage } from "./client";

export const THREAD_LIMIT = 20;
const MAX_MESSAGE_CHARS = 1000;
const MAX_TOTAL_CHARS = 6000;

export type ThreadMessage = {
  readonly role: "assistant" | "user";
  readonly user: string | null;
  readonly text: string;
};

export type ThreadOptions = {
  readonly botUserId: string;
  // The mention being answered is passed to the agent separately, so it is not repeated as context.
  readonly excludeTs: string;
};

// Keeps the newest messages that fit the budget. Every text is cut and goes through redactUntrusted: it is untrusted and may hold pasted secrets.
export function toThreadMessages(raw: readonly SlackThreadMessage[], { botUserId, excludeTs }: ThreadOptions): ThreadMessage[] {
  const mapped = raw
    .filter((m) => m.ts !== excludeTs && m.text.trim() !== "")
    .map((m): ThreadMessage => ({
      role: m.user === botUserId ? "assistant" : "user",
      user: m.user ?? m.botId,
      text: truncate(redactUntrusted(m.text), MAX_MESSAGE_CHARS),
    }));

  const kept: ThreadMessage[] = [];
  let total = 0;
  for (const message of mapped.reverse()) {
    total += message.text.length;
    if (total > MAX_TOTAL_CHARS) break;
    kept.unshift(message);
  }
  return kept;
}

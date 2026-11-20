import { redactUntrusted, truncate } from "../redact";
export const THREAD_LIMIT = 20;
const MAX_MESSAGE_CHARS = 1000;
const MAX_TOTAL_CHARS = 6000;
// Keeps the newest messages that fit the budget. Every text is cut and goes through redactUntrusted: it is untrusted and may hold pasted secrets.
export function toThreadMessages(raw, { botUserId, excludeTs }) {
    const mapped = raw
        .filter((m) => m.ts !== excludeTs && m.text.trim() !== "")
        .map((m) => ({
        role: m.user === botUserId ? "assistant" : "user",
        user: m.user ?? m.botId,
        text: truncate(redactUntrusted(m.text), MAX_MESSAGE_CHARS),
    }));
    const kept = [];
    let total = 0;
    for (const message of mapped.reverse()) {
        total += message.text.length;
        if (total > MAX_TOTAL_CHARS)
            break;
        kept.unshift(message);
    }
    return kept;
}

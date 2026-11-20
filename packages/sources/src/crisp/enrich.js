import { AUTOMATION_NOTE_PREFIX, isCrispSession } from "./event";
function toMessage(m) {
    if (typeof m.content !== "string" || m.content.trim() === "")
        return null;
    if (m.from !== "user" && m.from !== "operator")
        return null;
    if (m.type === "note" && m.content.startsWith(AUTOMATION_NOTE_PREFIX))
        return null;
    if (m.type !== "text" && m.type !== "note")
        return null;
    return { from: m.from, at: new Date(m.timestamp).toISOString(), text: m.content };
}
export function createCrispEnricher(client) {
    return async (event) => {
        if (!isCrispSession(event))
            return event;
        const { sessionId, websiteId } = event.payload;
        const [conversation, raw] = await Promise.all([client.conversation(sessionId), client.messages(sessionId)]);
        const request = {
            sessionId,
            websiteId,
            customer: conversation.email ? { email: conversation.email } : {},
            messages: raw
                .toSorted((a, b) => a.timestamp - b.timestamp)
                .map(toMessage)
                .filter((m) => m !== null),
            segments: conversation.segments,
        };
        return { ...event, payload: { ...event.payload, request } };
    };
}

import { z } from "zod";
import { SLACK_APP_MENTION, SLACK_SOURCE } from "./event";
const envelopeSchema = z.object({
    type: z.string(),
    challenge: z.string().optional(),
    team_id: z.string().nullish(),
    event_id: z.string().nullish(),
    authorizations: z.array(z.object({ user_id: z.string().nullish() })).nullish(),
    event: z
        .object({
        type: z.string(),
        user: z.string().nullish(),
        bot_id: z.string().nullish(),
        subtype: z.string().nullish(),
        text: z.string().nullish(),
        ts: z.string().nullish(),
        thread_ts: z.string().nullish(),
        channel: z.string().nullish(),
        team: z.string().nullish(),
    })
        .nullish(),
});
const LEADING_MENTION = /^\s*<@[A-Z0-9]+(?:\|[^>]*)?>[\s,:]*/;
const ignored = (reason) => ({ type: "ignored", reason });
const decode = (rawBody) => {
    try {
        return JSON.parse(new TextDecoder().decode(rawBody));
    }
    catch {
        return undefined;
    }
};
export function slackChallenge(rawBody) {
    const parsed = envelopeSchema.safeParse(decode(rawBody));
    if (!parsed.success || parsed.data.type !== "url_verification")
        return undefined;
    return parsed.data.challenge;
}
export function parseSlackWebhook(rawBody, receivedAt) {
    const json = decode(rawBody);
    if (json === undefined)
        return ignored("invalid_json");
    const parsed = envelopeSchema.safeParse(json);
    if (!parsed.success)
        return ignored("invalid_payload_shape");
    const { type, event, event_id: eventId, team_id: teamId, authorizations } = parsed.data;
    if (type !== "event_callback")
        return ignored(`unsupported_type:${type}`);
    if (!event || event.type !== SLACK_APP_MENTION)
        return ignored(`unsupported_event:${event?.type ?? "none"}`);
    if (event.bot_id || event.subtype === "bot_message")
        return ignored("bot_author");
    if (!eventId || !event.user || !event.channel || !event.ts)
        return ignored("invalid_payload_shape");
    // authorizations lists the installed app's own bot user, so a mention authored by it is the bot talking to itself.
    if (authorizations?.some((a) => a.user_id === event.user))
        return ignored("bot_author");
    const payload = {
        team: teamId ?? event.team ?? "",
        channel: event.channel,
        user: event.user,
        text: (event.text ?? "").replace(LEADING_MENTION, "").trim(),
        ts: event.ts,
        threadTs: event.thread_ts ?? null,
    };
    return {
        type: "event",
        event: {
            source: SLACK_SOURCE,
            kind: SLACK_APP_MENTION,
            externalId: eventId,
            receivedAt: receivedAt.toISOString(),
            payload,
        },
    };
}

import { SLACK_SOURCE } from "./event";
import { parseSlackWebhook, slackChallenge } from "./parse";
import { verifySlackSignature } from "./signature";
export function createSlackSource(options) {
    const now = options.now ?? Date.now;
    return {
        name: SLACK_SOURCE,
        verify: ({ headers, rawBody }) => verifySlackSignature(rawBody, headers, options.signingSecret, now()),
        respond: ({ rawBody }) => {
            const challenge = slackChallenge(rawBody);
            return challenge === undefined ? undefined : { body: { challenge } };
        },
        parse: ({ rawBody }, receivedAt) => parseSlackWebhook(rawBody, receivedAt),
    };
}

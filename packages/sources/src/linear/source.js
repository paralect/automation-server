import { LINEAR_SOURCE } from "./event";
import { parseLinearWebhook } from "./parse";
import { isFreshLinearWebhook, verifyLinearSignature } from "./signature";
export function createLinearSource(options) {
    const now = options.now ?? Date.now;
    return {
        name: LINEAR_SOURCE,
        verify: ({ headers, rawBody }) => verifyLinearSignature(rawBody, headers.get("linear-signature"), options.webhookSecret) &&
            isFreshLinearWebhook(rawBody, now()),
        parse: ({ rawBody }, receivedAt) => parseLinearWebhook(rawBody, receivedAt),
    };
}

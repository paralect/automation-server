import { createCrispClient } from "./client";
import { createCrispEnricher } from "./enrich";
import { CRISP_SOURCE } from "./event";
import { parseCrispWebhook } from "./parse";
import { isFreshCrispTimestamp, verifyCrispSignature } from "./signature";
export function createCrispSource(options) {
    const now = options.now ?? Date.now;
    const client = createCrispClient({
        websiteId: options.websiteId,
        identifier: options.pluginIdentifier,
        key: options.pluginKey,
        apiBaseUrl: options.apiBaseUrl,
        fetch: options.fetch,
    });
    return {
        name: CRISP_SOURCE,
        verify: ({ headers, rawBody }) => {
            const timestamp = headers.get("x-crisp-request-timestamp");
            return (verifyCrispSignature(rawBody, timestamp, headers.get("x-crisp-signature"), options.webhookSecret) &&
                isFreshCrispTimestamp(timestamp, now()));
        },
        parse: ({ rawBody }, receivedAt) => parseCrispWebhook(rawBody, receivedAt, options.websiteId),
        enrich: createCrispEnricher(client),
    };
}

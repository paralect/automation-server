import { createSentryIssueEnricher } from "./enrich";
import { SENTRY_SOURCE } from "./event";
import { parseSentryWebhook } from "./parse";
import { verifySignature } from "./signature";
export function createSentrySource(options) {
    const enrich = options.authToken && options.apiBaseUrl
        ? createSentryIssueEnricher({
            apiBaseUrl: options.apiBaseUrl,
            authToken: options.authToken,
            fetch: options.fetch,
        })
        : undefined;
    return {
        name: SENTRY_SOURCE,
        verify: ({ headers, rawBody }) => verifySignature(rawBody, headers.get("sentry-hook-signature"), options.clientSecret),
        parse: ({ headers, rawBody }, receivedAt) => parseSentryWebhook(headers, rawBody, receivedAt),
        ...(enrich ? { enrich } : {}),
    };
}

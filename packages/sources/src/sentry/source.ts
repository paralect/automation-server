import type { Source } from "@automation-server/core/source";

import { createSentryIssueEnricher } from "./enrich";
import { SENTRY_SOURCE } from "./event";
import { parseSentryWebhook } from "./parse";
import { verifySignature } from "./signature";

export type SentrySourceOptions = {
  readonly clientSecret: string;
  readonly apiBaseUrl?: string;
  readonly authToken?: string;
  readonly fetch?: typeof fetch;
};

export function createSentrySource(options: SentrySourceOptions): Source {
  const enrich =
    options.authToken && options.apiBaseUrl
      ? createSentryIssueEnricher({
          apiBaseUrl: options.apiBaseUrl,
          authToken: options.authToken,
          fetch: options.fetch,
        })
      : undefined;

  return {
    name: SENTRY_SOURCE,
    verify: ({ headers, rawBody }) =>
      verifySignature(rawBody, headers.get("sentry-hook-signature"), options.clientSecret),
    parse: ({ headers, rawBody }, receivedAt) => parseSentryWebhook(headers, rawBody, receivedAt),
    ...(enrich ? { enrich } : {}),
  };
}

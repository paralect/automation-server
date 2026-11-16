import type { Source } from "@automation-server/core/source";

import { createCrispClient } from "./client";
import { createCrispEnricher } from "./enrich";
import { CRISP_SOURCE } from "./event";
import { parseCrispWebhook } from "./parse";
import { isFreshCrispTimestamp, verifyCrispSignature } from "./signature";

export type CrispSourceOptions = {
  readonly websiteId: string;
  readonly webhookSecret: string;
  readonly pluginIdentifier: string;
  readonly pluginKey: string;
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
};

export function createCrispSource(options: CrispSourceOptions): Source {
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
      return (
        verifyCrispSignature(rawBody, timestamp, headers.get("x-crisp-signature"), options.webhookSecret) &&
        isFreshCrispTimestamp(timestamp, now())
      );
    },
    parse: ({ rawBody }, receivedAt) => parseCrispWebhook(rawBody, receivedAt, options.websiteId),
    enrich: createCrispEnricher(client),
  };
}

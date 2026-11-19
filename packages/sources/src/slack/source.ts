import type { Source } from "@automation-server/core/source";

import { SLACK_SOURCE } from "./event";
import { parseSlackWebhook, slackChallenge } from "./parse";
import { verifySlackSignature } from "./signature";

export type SlackSourceOptions = {
  readonly signingSecret: string;
  readonly now?: () => number;
};

export function createSlackSource(options: SlackSourceOptions): Source {
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

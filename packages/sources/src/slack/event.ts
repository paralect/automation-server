import type { Event } from "@automation-server/core/event";

export const SLACK_SOURCE = "slack";
export const SLACK_APP_MENTION = "app_mention";

export type SlackAppMention = {
  readonly team: string;
  readonly channel: string;
  readonly user: string;
  readonly text: string;
  readonly ts: string;
  readonly threadTs: string | null;
};

export type SlackAppMentionEvent = Event<SlackAppMention, typeof SLACK_APP_MENTION>;

export function isSlackAppMention(event: Event): event is SlackAppMentionEvent {
  return event.source === SLACK_SOURCE && event.kind === SLACK_APP_MENTION;
}

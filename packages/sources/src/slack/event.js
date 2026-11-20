export const SLACK_SOURCE = "slack";
export const SLACK_APP_MENTION = "app_mention";
export function isSlackAppMention(event) {
    return event.source === SLACK_SOURCE && event.kind === SLACK_APP_MENTION;
}

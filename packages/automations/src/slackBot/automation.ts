import { defineAutomation, type Automation } from "@automation-server/core/automation";
import { isSlackAppMention, type SlackAppMention, type SlackAppMentionEvent } from "@automation-server/sources/slack/event";

import { redactText, singleLine, truncate } from "../redact";
import type { SlackBotClient } from "./client";
import { createSlackBotLimiter, type Admission, type SlackBotLimiter } from "./limiter";

export const SLACK_BOT = "slack-bot";

export const DENIED_REPLY = "You are not allowed to use this bot. Ask an admin to add your member ID.";

const MAX_ECHO_CHARS = 2000;
const MAX_LOGGED_CHARS = 200;

export type SlackBotHandler = (mention: SlackAppMention) => Promise<string>;

export type SlackBotConfig = {
  client: SlackBotClient;
  allowedUsers: readonly string[];
  handler?: SlackBotHandler;
  // Rate limits and the in-flight cap. A bot built without one gets its own, so the limits are never off.
  limiter?: SlackBotLimiter;
};

// Slack treats <!channel> and <@U123> as live markup, so text that came from a person must never reach it unescaped.
export const escapeSlackText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const echoHandler: SlackBotHandler = async ({ text }) =>
  `Got it: ${escapeSlackText(truncate(text, MAX_ECHO_CHARS)) || "(empty message)"}`;

export function createSlackBot({ client, allowedUsers, handler = echoHandler, limiter = createSlackBotLimiter({ denialReply: DENIED_REPLY }) }: SlackBotConfig): Automation {
  const allowed = new Set(allowedUsers);

  return defineAutomation({
    name: SLACK_BOT,
    matches: (event): event is SlackAppMentionEvent => isSlackAppMention(event),
    async run(event, { log, dryRun, report }) {
      const mention = event.payload;
      const thread = mention.threadTs ?? mention.ts;
      const target = { channel: mention.channel, thread, user: mention.user };

      const permitted = allowed.has(mention.user);
      // A dry run posts nothing and may be a replay, so it must not spend the asker's quota or a slot.
      const admission: Admission = dryRun
        ? permitted
          ? { kind: "run", release() {} }
          : { kind: "denied", reply: DENIED_REPLY }
        : limiter.admit({ project: event.project ?? "", user: mention.user, allowed: permitted });

      try {
        const reply = admission.kind === "run" ? await handler(mention) : admission.reply;
        const decision = admission.kind === "run" ? "replied" : admission.kind;

        if (reply === null) {
          log.info("dropped without a reply", { ...target, decision });
          report?.({ ...target, decision });
          return;
        }

        if (dryRun) {
          log.info("dry-run: would reply", { ...target, decision, reply: truncate(singleLine(redactText(reply)), MAX_LOGGED_CHARS) });
          report?.({ ...target, decision, dryRun: true, wouldReply: redactText(reply) });
          return;
        }

        const { ts } = await client.postMessage({ channel: mention.channel, threadTs: thread, text: reply });
        log.info(admission.kind === "run" ? "replied in thread" : admission.kind === "denied" ? "denied unlisted user" : `sent ${decision} notice`, { ...target, replyTs: ts });
        report?.({ ...target, decision, replyTs: ts });
      } finally {
        if (admission.kind === "run") admission.release();
      }
    },
  });
}

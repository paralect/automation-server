import { defineAutomation, type Automation, type AutomationContext } from "@automation-server/core/automation";
import { isSlackAppMention, type SlackAppMentionEvent } from "@automation-server/sources/slack/event";
import type { SlackBotOutcome } from "@automation-server/sources/slack/outcome";

import { redactUntrusted, singleLine, truncate } from "../redact";
import type { AgentStatus, StepLog } from "./agent";
import { escapeSlackText, type SlackBotClient } from "./client";
import { createSlackBotLimiter, type Admission, type SlackBotLimiter } from "./limiter";

export const SLACK_BOT = "slack-bot";

export const DENIED_REPLY = "You are not allowed to use this bot. Ask an admin to add your member ID.";

const MAX_ECHO_CHARS = 2000;
const MAX_LOGGED_CHARS = 200;
const MAX_REASON_CHARS = 300;

export type SlackBotSettings = {
  readonly allowedUsers: readonly string[];
};

export type SlackBotHandlerInput = {
  readonly event: SlackAppMentionEvent;
  readonly ctx: AutomationContext;
  readonly client: SlackBotClient;
  readonly config: SlackBotSettings;
};

export type SlackBotStatus = AgentStatus | "executed" | "cancelled" | "expired";

// The reply is posted as is, so a handler must hand back text that is already safe for Slack. Steps and status are optional, a plain reply is enough.
export type SlackBotHandlerResult = {
  readonly reply: string;
  readonly steps?: readonly StepLog[];
  readonly status?: SlackBotStatus;
  readonly error?: string;
};

export type SlackBotHandler = (input: SlackBotHandlerInput) => Promise<SlackBotHandlerResult>;

export type SlackBotConfig = {
  client: SlackBotClient;
  allowedUsers: readonly string[];
  handler?: SlackBotHandler;
  // Rate limits and the in-flight cap. A bot built without one gets its own, so the limits are never off.
  limiter?: SlackBotLimiter;
};

export const echoHandler: SlackBotHandler = async ({ event }) => ({
  reply: `Got it: ${escapeSlackText(truncate(event.payload.text, MAX_ECHO_CHARS)) || "(empty message)"}`,
});

const failureReply = (err: unknown): SlackBotHandlerResult => {
  const reason = truncate(singleLine(redactUntrusted(err instanceof Error ? err.message : String(err))), MAX_REASON_CHARS);
  return { reply: escapeSlackText(`I could not do that: ${reason}`), status: "failed", error: reason, steps: [] };
};

function agentOutcome({ status, steps = [], error }: SlackBotHandlerResult): SlackBotOutcome["agent"] {
  if (!status) return undefined;
  return {
    status,
    stepCount: steps.length,
    toolsUsed: [...new Set(steps.map((s) => s.tool))],
    steps: steps.map(({ tool, ok, durationMs, stage }) => ({ tool, ok, durationMs, ...(stage ? { stage } : {}) })),
    ...(error ? { error } : {}),
  };
}

export function createSlackBot({ client, allowedUsers, handler = echoHandler, limiter = createSlackBotLimiter({ denialReply: DENIED_REPLY }) }: SlackBotConfig): Automation {
  const allowed = new Set(allowedUsers);
  const config: SlackBotSettings = { allowedUsers: [...allowedUsers] };

  return defineAutomation({
    name: SLACK_BOT,
    matches: (event): event is SlackAppMentionEvent => isSlackAppMention(event),
    async run(event, ctx) {
      const { log, dryRun, report } = ctx;
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
        let result: SlackBotHandlerResult | null;
        if (admission.kind === "run") {
          // A handler that throws must not fail the run: the person still gets an answer in the thread, and Slack must not retry into a second reply.
          result = await handler({ event, ctx, client, config }).catch(failureReply);
          for (const step of result.steps ?? []) {
            log.info("agent step", { step: step.index, tool: step.tool, args: step.args, ok: step.ok, ...(step.stage ? { stage: step.stage } : {}), durationMs: step.durationMs, ...(step.error ? { error: step.error } : {}) });
          }
        } else {
          result = admission.reply === null ? null : { reply: admission.reply };
        }
        const decision = admission.kind === "run" ? "replied" : admission.kind;
        const agent = result ? agentOutcome(result) : undefined;

        if (!result) {
          log.info("dropped without a reply", { ...target, decision });
          report?.({ ...target, decision } satisfies SlackBotOutcome);
          return;
        }

        if (dryRun) {
          log.info("dry-run: would reply", { ...target, decision, reply: truncate(singleLine(redactUntrusted(result.reply)), MAX_LOGGED_CHARS) });
          report?.({ ...target, decision, dryRun: true, wouldReply: redactUntrusted(result.reply), ...(agent ? { agent } : {}) } satisfies SlackBotOutcome);
          return;
        }

        const { ts } = await client.postMessage({ channel: mention.channel, threadTs: thread, text: result.reply });
        log.info(admission.kind === "run" ? "replied in thread" : admission.kind === "denied" ? "denied unlisted user" : `sent ${decision} notice`, { ...target, replyTs: ts, ...(result.status ? { status: result.status } : {}) });
        report?.({ ...target, decision, replyTs: ts, ...(agent ? { agent } : {}) } satisfies SlackBotOutcome);
      } finally {
        if (admission.kind === "run") admission.release();
      }
    },
  });
}

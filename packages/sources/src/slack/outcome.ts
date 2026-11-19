import { z } from "zod";

export const SLACK_AGENT_STATUSES = ["answered", "exhausted", "failed", "not-configured", "pending-approval", "executed", "cancelled", "expired"] as const;
export const SLACK_STEP_STAGES = ["proposed", "approved", "executed", "cancelled"] as const;

const text = z.string();

export const slackBotOutcomeSchema = z.object({
  channel: text,
  thread: text,
  user: text,
  decision: z.enum(["replied", "denied", "rate-limited", "busy"]),
  replyTs: text.optional(),
  // Present only on dry runs, where nothing is posted.
  dryRun: z.literal(true).optional(),
  wouldReply: text.optional(),
  // Present when the agent ran. Compact on purpose: the full step log is in the run's logs.
  agent: z
    .object({
      status: z.enum(SLACK_AGENT_STATUSES),
      stepCount: z.number(),
      toolsUsed: z.array(text),
      // A write is only ever proposed by the model. Its stage says how far the approval went.
      steps: z.array(z.object({ tool: text, ok: z.boolean(), durationMs: z.number(), stage: z.enum(SLACK_STEP_STAGES).optional() })),
      error: text.optional(),
    })
    .optional(),
});

export type SlackBotOutcome = z.infer<typeof slackBotOutcomeSchema>;

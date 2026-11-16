import { z } from "zod";

export const CRISP_DECISIONS = ["drop", "needs_info", "answer", "issue", "fix"] as const;
export type CrispDecision = (typeof CRISP_DECISIONS)[number];

const text = z.string();

/**
 * What one crisp-triage run decided, stored on the run for the admin. Every string is already redacted: it holds
 * no email, phone, card number or message body, only the classifier's own words.
 */
export const crispOutcomeSchema = z.object({
  version: z.literal(1),
  decision: z.enum(CRISP_DECISIONS),
  /** The route table row that decided, or `duplicate` / `no_user_text`. */
  rule: text,
  mode: z.enum(["shadow", "issue", "fix"]),
  sessionId: text,
  inboxUrl: text,
  verdict: z
    .object({
      category: text,
      severity: text,
      area: text,
      confidence: z.number(),
      model: text,
      summary: text,
      repro: z.object({ steps: z.array(text), expected: text, actual: text }).nullable(),
      evidence: z.array(text),
      missing: z.array(text),
    })
    .nullable(),
  /** For needs_info: what to ask the customer. */
  questions: z.array(text),
  /** For answer: the draft an operator can send. */
  answerDraft: text.nullable(),
  /** For drop. */
  dropReason: z.enum(["spam", "duplicate"]).nullable(),
  duplicateOf: text.nullable(),
  github: z.object({
    /** False in shadow mode: nothing was written. */
    written: z.boolean(),
    issue: z.object({ number: z.number(), url: text }).nullable(),
    labels: z.array(text),
    dispatched: z.boolean(),
    dispatchError: text.nullable(),
  }),
  crisp: z.object({
    /** The `triage:<decision>` segment this run sets. */
    segment: text,
    /** True when written, false when Crisp refused (a plan without API writes), null when not tried yet. */
    notePosted: z.boolean().nullable(),
    segmentSet: z.boolean().nullable(),
  }),
  /** The private note this run posts, or would post, to the conversation. */
  note: text,
});

export type CrispOutcome = z.infer<typeof crispOutcomeSchema>;

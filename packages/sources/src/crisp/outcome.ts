import { z } from "zod";

export const CRISP_DECISIONS = ["drop", "needs_info", "answer", "issue", "fix"] as const;
export type CrispDecision = (typeof CRISP_DECISIONS)[number];

const text = z.string();

export const crispOutcomeSchema = z.object({
  version: z.literal(1),
  decision: z.enum(CRISP_DECISIONS),
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
  questions: z.array(text),
  answerDraft: text.nullable(),
  dropReason: z.enum(["spam", "duplicate"]).nullable(),
  duplicateOf: text.nullable(),
  github: z.object({
    written: z.boolean(),
    issue: z.object({ number: z.number(), url: text }).nullable(),
    labels: z.array(text),
    dispatched: z.boolean(),
    dispatchError: text.nullable(),
  }),
  crisp: z.object({
    segment: text,
    notePosted: z.boolean().nullable(),
    segmentSet: z.boolean().nullable(),
  }),
  note: text,
  // Present only on dry runs: what a real run would have written. `note` then holds the note it would have posted.
  dryRun: z.literal(true).optional(),
  wouldDo: z
    .object({
      issue: z.object({ title: text, labels: z.array(text) }).nullable(),
      dispatch: z.boolean(),
    })
    .optional(),
});

export type CrispOutcome = z.infer<typeof crispOutcomeSchema>;

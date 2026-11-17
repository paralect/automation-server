import { z } from "zod";

export const TRIAGE_VERSION = "crisp-triage/1";

export const CATEGORIES = [
  "bug",
  "regression",
  "feature_request",
  "how_to",
  "account_billing",
  "data_fix",
  "performance",
  "spam",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const SEVERITIES = ["blocker", "major", "minor", "cosmetic"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const UNKNOWN_AREA = "unknown";

export const MODES = ["shadow", "issue", "fix"] as const;
export type Mode = (typeof MODES)[number];

export function triageSchema(areas: readonly string[]) {
  return z.object({
    category: z.enum(CATEGORIES),
    confidence: z
      .number()
      .refine((n) => n >= 0 && n <= 1, "must be between 0 and 1")
      .describe("How sure you are of the category, from 0 to 1."),
    severity: z.enum(SEVERITIES),
    area: z.enum([...new Set([...areas, UNKNOWN_AREA])] as [string, ...string[]]),
    summary: z.string().describe("One or two English sentences. No names, emails or other personal data."),
    repro: z
      .object({ steps: z.array(z.string()), expected: z.string(), actual: z.string() })
      .nullable()
      .describe("Null unless the conversation gives enough to reproduce the problem."),
    missing: z.array(z.string()).describe("Questions whose answers are needed to reproduce or act on the request."),
    evidence: z.array(z.string()).describe("Short verbatim quotes from the conversation that support the verdict."),
    answerDraft: z.string().nullable().describe("For how_to only: a reply the operator could send. Null otherwise."),
  });
}

export type Triage = z.infer<ReturnType<typeof triageSchema>>;

export type Decision =
  | { readonly kind: "drop"; readonly reason: "spam" | "duplicate"; readonly duplicateOf?: string }
  | { readonly kind: "needs_info"; readonly questions: readonly string[] }
  | { readonly kind: "answer"; readonly draft: string }
  | { readonly kind: "issue"; readonly labels: readonly string[] }
  | { readonly kind: "fix"; readonly labels: readonly string[] };

export type DecisionKind = Decision["kind"];

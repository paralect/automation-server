import { UNKNOWN_AREA, type Category, type Decision, type Mode, type Triage } from "./types";

export type RouteContext = {
  readonly triage: Triage;
  readonly minConfidence: number;
  readonly autofixAreas: readonly string[];
};

export type Route = {
  readonly name: string;
  readonly when: (ctx: RouteContext) => boolean;
  readonly decide: (ctx: RouteContext) => Decision;
};

const isBug = (t: Triage) => t.category === "bug" || t.category === "regression";

const TRACKED_LABEL: Partial<Record<Category, string>> = {
  feature_request: "feature-request",
  performance: "performance",
  data_fix: "data",
  account_billing: "account-billing",
};

const trackedLabel = (t: Triage): string | undefined => TRACKED_LABEL[t.category];

const FALLBACK_QUESTION = "Could you describe the steps you took, what you expected and what happened instead?";

export const ROUTES: readonly Route[] = [
  { name: "spam", when: ({ triage }) => triage.category === "spam", decide: () => ({ kind: "drop", reason: "spam" }) },
  {
    name: "incomplete",
    when: ({ triage, minConfidence }) =>
      (isBug(triage) && triage.repro === null) || triage.confidence < minConfidence,
    decide: ({ triage }) => ({ kind: "needs_info", questions: triage.missing.length > 0 ? triage.missing : [FALLBACK_QUESTION] }),
  },
  {
    name: "how_to",
    when: ({ triage }) => triage.category === "how_to",
    decide: ({ triage }) => ({ kind: "answer", draft: triage.answerDraft ?? "" }),
  },
  {
    name: "tracked",
    when: ({ triage }) => trackedLabel(triage) !== undefined,
    decide: ({ triage }) => ({ kind: "issue", labels: [trackedLabel(triage) ?? "triage-unsure"] }),
  },
  {
    name: "autofix",
    when: ({ triage, autofixAreas }) =>
      isBug(triage) &&
      triage.severity !== "blocker" &&
      triage.area !== UNKNOWN_AREA &&
      autofixAreas.some((a) => a.toLowerCase() === triage.area.toLowerCase()),
    decide: () => ({ kind: "fix", labels: ["bug", "autofix"] }),
  },
  { name: "bug", when: ({ triage }) => isBug(triage), decide: () => ({ kind: "issue", labels: ["bug"] }) },
  { name: "unsure", when: () => true, decide: () => ({ kind: "issue", labels: ["triage-unsure"] }) },
];

export function route(ctx: RouteContext): { rule: string; decision: Decision } {
  for (const r of ROUTES) {
    if (r.when(ctx)) return { rule: r.name, decision: r.decide(ctx) };
  }
  throw new Error("no route matched");
}

export function applyMode(decision: Decision, mode: Mode): { decision: Decision; github: boolean } {
  if (mode === "shadow") return { decision, github: false };
  if (mode === "issue" && decision.kind === "fix") {
    return { decision: { kind: "issue", labels: decision.labels.filter((l) => l !== "autofix") }, github: true };
  }
  return { decision, github: true };
}

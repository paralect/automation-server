import { Link } from "@tanstack/react-router"
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  ChatCircleDotsIcon,
  GithubLogoIcon,
  LightbulbIcon,
  ProhibitIcon,
  QuestionIcon,
  WarningCircleIcon,
  WrenchIcon,
} from "@phosphor-icons/react"
import type { ComponentType } from "react"
import { cn } from "cn"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Time } from "@/components/time"
import type { CrispOutcome, CrispTriageItem } from "@/lib/api.functions"
import type { CrispDecisionKey } from "@/lib/filters"

type DecisionView = { label: string; icon: ComponentType<{ className?: string }>; tone: string }

/** What each decision means for the team, in the order of how much attention it needs. */
export const DECISION_VIEW: Record<CrispDecisionKey, DecisionView> = {
  fix: { label: "Fix started", icon: WrenchIcon, tone: "bg-blue-500/15 text-blue-700 dark:text-blue-400" },
  issue: { label: "Issue created", icon: GithubLogoIcon, tone: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  needs_info: { label: "Needs info", icon: QuestionIcon, tone: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  answer: { label: "Answer drafted", icon: LightbulbIcon, tone: "bg-violet-500/15 text-violet-700 dark:text-violet-400" },
  drop: { label: "Dropped", icon: ProhibitIcon, tone: "bg-muted text-muted-foreground" },
}

/** Why the triage chose that, in plain words. Keys are the route names of the triage rules. */
const RULE_WHY: Record<string, string> = {
  spam: "Looks like spam, so nothing was created.",
  duplicate: "An open GitHub issue already tracks this conversation.",
  no_user_text: "The customer has not described the problem yet.",
  how_to: "A how-to question. An answer is drafted for an operator to send.",
  incomplete: "Not enough to act on: the bug has no reproduction steps, or the classifier was not sure enough.",
  tracked: "A request to track rather than a bug to fix, so it became an issue for people.",
  autofix: "A reproducible bug that is not a blocker, in an area allowed for automatic fixes.",
  bug: "A bug outside the automatic fix areas, or a blocker, so people handle it.",
  unsure: "Could not be classified with confidence, so it is flagged for people to look at.",
}

const CATEGORY: Record<string, string> = {
  bug: "Bug",
  regression: "Regression",
  feature_request: "Feature request",
  how_to: "How-to",
  account_billing: "Account or billing",
  data_fix: "Data fix",
  performance: "Performance",
  spam: "Spam",
  other: "Other",
}

const SEVERITY_TONE: Record<string, string> = {
  blocker: "bg-destructive/15 text-destructive",
  major: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
}

export const MODE_COPY = {
  shadow: "Shadow: decisions are only recorded, nothing is written to GitHub.",
  issue: "Issue: creates GitHub issues, never starts a fix.",
  fix: "Fix: creates GitHub issues and starts the Codex fix for eligible bugs.",
} as const

const Chip = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <Badge variant="secondary" className={cn("font-normal", className)}>
    {children}
  </Badge>
)

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-1">
    <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
    {children}
  </div>
)

const ExternalLink = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a
    href={href}
    target="_blank"
    rel="noreferrer"
    className="inline-flex items-center gap-1 underline-offset-4 hover:underline focus-visible:underline"
  >
    {children}
    <ArrowSquareOutIcon className="size-3" aria-hidden />
  </a>
)

const issueLabel = (url: string) => {
  const last = url.split("/").pop() ?? ""
  return /^\d+$/.test(last) ? `issue #${last}` : "an open issue"
}

const Fact = ({ children }: { children: React.ReactNode }) => (
  <li className="flex items-start gap-2">{children}</li>
)

function Headline({ item }: { item: CrispTriageItem }) {
  const { outcome } = item
  if (!outcome && item.status !== "failed") {
    return <Badge variant="outline">{item.status === "running" ? "Running" : "No details"}</Badge>
  }
  if (!outcome) {
    return (
      <Badge variant="destructive" className="gap-1">
        <WarningCircleIcon className="size-3" aria-hidden />
        Failed
      </Badge>
    )
  }
  const view = DECISION_VIEW[outcome.decision]
  const Icon = view.icon
  return (
    <Badge variant="secondary" className={cn("gap-1", view.tone)}>
      <Icon className="size-3" aria-hidden />
      {view.label}
      {outcome.decision === "drop" && outcome.dropReason ? ` · ${outcome.dropReason}` : ""}
    </Badge>
  )
}

/** The actual results of the run: what was created and what was written back to Crisp. */
function Results({ outcome }: { outcome: CrispOutcome }) {
  const { github, crisp } = outcome
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {github.issue ? (
        <Fact>
          <CheckCircleIcon className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
          <span>
            GitHub issue <ExternalLink href={github.issue.url}>#{github.issue.number}</ExternalLink>
          </span>
        </Fact>
      ) : outcome.duplicateOf ? (
        <Fact>
          <ProhibitIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span>
            Already tracked in <ExternalLink href={outcome.duplicateOf}>{issueLabel(outcome.duplicateOf)}</ExternalLink>
          </span>
        </Fact>
      ) : (outcome.decision === "issue" || outcome.decision === "fix") && !github.written ? (
        <Fact>
          <ProhibitIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="text-muted-foreground">Nothing was written to GitHub, the server runs in shadow mode.</span>
        </Fact>
      ) : null}
      {outcome.decision === "fix" &&
        (github.dispatched ? (
          <Fact>
            <CheckCircleIcon className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
            <span>Codex fix workflow started. A draft pull request appears if the bug can be reproduced.</span>
          </Fact>
        ) : github.dispatchError ? (
          <Fact>
            <WarningCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <span className="text-destructive">Could not start the fix workflow: {github.dispatchError}</span>
          </Fact>
        ) : null)}
      <Fact>
        {crisp.segmentSet === false ? (
          <WarningCircleIcon className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
        ) : (
          <CheckCircleIcon className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
        )}
        <span>
          {crisp.segmentSet === false ? "Crisp refused the status segment " : "Conversation marked in Crisp as "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">{crisp.segment}</code>
        </span>
      </Fact>
      {crisp.notePosted === false && (
        <Fact>
          <WarningCircleIcon className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
          <span className="text-muted-foreground">
            Crisp did not accept the private note (the plan does not allow API notes). Its text is below.
          </span>
        </Fact>
      )}
    </ul>
  )
}

function Details({ item, outcome }: { item: CrispTriageItem; outcome: CrispOutcome }) {
  const { verdict } = outcome
  return (
    <details className="group rounded-md border bg-muted/30 px-3 py-2 text-sm">
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground select-none">
        Details: reproduction, evidence and note
      </summary>
      <div className="mt-3 flex flex-col gap-4">
        {verdict?.repro && (
          <Section title="Reproduction">
            <ol className="list-decimal pl-5">
              {verdict.repro.steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
            <p>
              <span className="text-muted-foreground">Expected: </span>
              {verdict.repro.expected}
            </p>
            <p>
              <span className="text-muted-foreground">Actual: </span>
              {verdict.repro.actual}
            </p>
          </Section>
        )}
        {verdict && verdict.evidence.length > 0 && (
          <Section title="What the customer wrote">
            <ul className="flex flex-col gap-1">
              {verdict.evidence.map((quote, i) => (
                <li key={i} className="border-l-2 pl-3 text-muted-foreground">
                  {quote}
                </li>
              ))}
            </ul>
          </Section>
        )}
        <Section title="Private note for the conversation">
          <pre className="rounded bg-background p-2 text-xs/relaxed break-words whitespace-pre-wrap">{outcome.note}</pre>
        </Section>
        <Section title="Technical">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs">
            <dt className="text-muted-foreground">Rule</dt>
            <dd>{outcome.rule}</dd>
            <dt className="text-muted-foreground">Mode</dt>
            <dd>{outcome.mode}</dd>
            {verdict && (
              <>
                <dt className="text-muted-foreground">Model</dt>
                <dd>{verdict.model}</dd>
                <dt className="text-muted-foreground">Confidence</dt>
                <dd>{Math.round(verdict.confidence * 100)}%</dd>
              </>
            )}
            <dt className="text-muted-foreground">Conversation</dt>
            <dd className="font-mono break-all">{outcome.sessionId}</dd>
            <dt className="text-muted-foreground">Run</dt>
            <dd>
              <Link to="/runs/$id" params={{ id: item.id }} className="underline-offset-4 hover:underline">
                open run and logs
              </Link>
            </dd>
          </dl>
        </Section>
      </div>
    </details>
  )
}

export function CrispCard({ item }: { item: CrispTriageItem }) {
  const { outcome } = item
  const verdict = outcome?.verdict
  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Headline item={item} />
          {verdict && (
            <>
              <Chip>{CATEGORY[verdict.category] ?? verdict.category}</Chip>
              {verdict.category !== "spam" && <Chip className={SEVERITY_TONE[verdict.severity]}>{verdict.severity}</Chip>}
              {verdict.category !== "spam" && verdict.area !== "unknown" && <Chip>{verdict.area}</Chip>}
            </>
          )}
          <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
            <Time iso={item.startedAt} relativeOnly />
            {outcome && <ExternalLink href={outcome.inboxUrl}>Open in Crisp</ExternalLink>}
          </span>
        </div>

        {outcome ? (
          <>
            <div>
              <p className="text-sm font-medium">{verdict?.summary ?? RULE_WHY[outcome.rule]}</p>
              {verdict && <p className="mt-0.5 text-xs text-muted-foreground">{RULE_WHY[outcome.rule] ?? ""}</p>}
            </div>

            {outcome.decision === "needs_info" && outcome.questions.length > 0 && (
              <Section title="Ask the customer">
                <ul className="list-disc pl-5 text-sm">
                  {outcome.questions.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ul>
              </Section>
            )}
            {outcome.decision === "answer" && (
              <Section title="Draft answer">
                <p className="rounded-md bg-muted/50 p-3 text-sm whitespace-pre-wrap">{outcome.answerDraft ?? "No draft was written."}</p>
              </Section>
            )}

            <Results outcome={outcome} />
            <Details item={item} outcome={outcome} />
          </>
        ) : item.status !== "failed" ? (
          <p className="text-sm text-muted-foreground">
            {item.status === "running"
              ? "The triage is running."
              : "This run finished before the admin recorded decisions, so only its log is available."}{" "}
            <Link to="/runs/$id" params={{ id: item.id }} className="underline underline-offset-4">
              Open run and logs
            </Link>
          </p>
        ) : (
          <div className="flex flex-col gap-2 text-sm">
            <p className="font-medium text-destructive">The triage failed before it decided anything.</p>
            {item.error && <p className="text-muted-foreground">{item.error}</p>}
            <p className="text-xs text-muted-foreground">
              The conversation is not marked in Crisp. Remove and add the trigger segment again to retry.{" "}
              <Link to="/runs/$id" params={{ id: item.id }} className="underline underline-offset-4">
                Open run and logs
              </Link>
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export const CrispIcon = ChatCircleDotsIcon

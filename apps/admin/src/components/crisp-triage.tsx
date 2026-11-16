import { useEffect, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  ChatCircleDotsIcon,
  CheckIcon,
  CopyIcon,
  EnvelopeSimpleIcon,
  EnvelopeSimpleOpenIcon,
  GithubLogoIcon,
  LightbulbIcon,
  ProhibitIcon,
  QuestionIcon,
  WarningCircleIcon,
  WrenchIcon,
} from "@phosphor-icons/react"
import type { ComponentType } from "react"
import { cn } from "cn"

import { Time } from "@/components/time"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { CrispOutcome, CrispTriageItem } from "@/lib/api.functions"
import type { CrispDecisionKey } from "@/lib/filters"

type DecisionView = { label: string; icon: ComponentType<{ className?: string }>; tone: string }

/** What each decision means for the team. */
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

const issueLabel = (url: string) => {
  const last = url.split("/").pop() ?? ""
  return /^\d+$/.test(last) ? `issue #${last}` : "an open issue"
}

/** One line of what happened, for the list. */
function headline(item: CrispTriageItem): string {
  const { outcome } = item
  if (!outcome) return item.status === "failed" ? "The triage failed before it decided anything" : "No details were recorded"
  return outcome.verdict?.summary ?? RULE_WHY[outcome.rule] ?? "Triaged"
}

function DecisionBadge({ item }: { item: CrispTriageItem }) {
  const { outcome } = item
  if (!outcome) {
    return item.status === "failed" ? (
      <Badge variant="destructive" className="gap-1">
        <WarningCircleIcon className="size-3" aria-hidden />
        Failed
      </Badge>
    ) : (
      <Badge variant="outline">{item.status === "running" ? "Running" : "No details"}</Badge>
    )
  }
  const view = DECISION_VIEW[outcome.decision]
  const Icon = view.icon
  return (
    <Badge variant="secondary" className={cn("gap-1", view.tone)}>
      <Icon className="size-3" aria-hidden />
      {view.label}
    </Badge>
  )
}

/** A short result for the list: the issue number, or why nothing was created. */
function resultText(item: CrispTriageItem): string | null {
  const o = item.outcome
  if (!o) return null
  if (o.github.issue) return `#${o.github.issue.number}${o.decision === "fix" && o.github.dispatched ? " · fix started" : ""}`
  if (o.dropReason) return o.dropReason
  return null
}

/** One conversation in the list. Unread ones are bold with a dot. */
export function CrispRow({ item, selected, onOpen }: { item: CrispTriageItem; selected: boolean; onOpen: () => void }) {
  const verdict = item.outcome?.verdict
  const result = resultText(item)
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "grid w-full grid-cols-[0.75rem_9rem_1fr_auto] items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
          // Unread rows are white, read ones gray.
          item.read ? "bg-muted hover:bg-muted/70" : "bg-background hover:bg-muted/40",
          selected && "ring-2 ring-inset ring-primary/40"
        )}
      >
        <span
          className={cn("size-2 rounded-full", item.read ? "bg-transparent" : "bg-primary")}
          role="img"
          aria-label={item.read ? "Read" : "Unread"}
        />
        <span>
          <DecisionBadge item={item} />
        </span>
        <span className="min-w-0">
          <span className={cn("block truncate", item.read ? "text-muted-foreground" : "font-medium")}>{headline(item)}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            {verdict && <span>{CATEGORY[verdict.category] ?? verdict.category}</span>}
            {verdict && verdict.category !== "spam" && <span className={cn(SEVERITY_TONE[verdict.severity] && "font-medium")}>{verdict.severity}</span>}
            {verdict && verdict.category !== "spam" && verdict.area !== "unknown" && <span>{verdict.area}</span>}
            {result && <span className="font-mono">{result}</span>}
          </span>
        </span>
        <span className="text-xs text-muted-foreground">
          <Time iso={item.startedAt} relativeOnly />
        </span>
      </button>
    </li>
  )
}

/** Copies text, with a short confirmation. Falls back to a hidden textarea where the clipboard API is blocked. */
export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const area = document.createElement("textarea")
      area.value = text
      area.style.position = "fixed"
      area.style.opacity = "0"
      document.body.append(area)
      area.select()
      document.execCommand("copy")
      area.remove()
    }
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Button type="button" variant="outline" size="sm" className={className} onClick={() => void copy()}>
      {copied ? <CheckIcon /> : <CopyIcon />}
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </Button>
  )
}

const Section = ({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) => (
  <section className="flex flex-col gap-1.5">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {action}
    </div>
    {children}
  </section>
)

const ExternalLink = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-4">
    {children}
    <ArrowSquareOutIcon className="size-3" aria-hidden />
  </a>
)

function Results({ outcome }: { outcome: CrispOutcome }) {
  const { github, crisp } = outcome
  const row = (icon: React.ReactNode, body: React.ReactNode, key: string) => (
    <li key={key} className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span>{body}</span>
    </li>
  )
  const ok = <CheckCircleIcon className="size-4 text-emerald-600" aria-hidden />
  const warn = <WarningCircleIcon className="size-4 text-amber-600" aria-hidden />
  const none = <ProhibitIcon className="size-4 text-muted-foreground" aria-hidden />

  const items: React.ReactNode[] = []
  if (github.issue) {
    items.push(row(ok, <>GitHub issue <ExternalLink href={github.issue.url}>#{github.issue.number}</ExternalLink></>, "issue"))
  } else if (outcome.duplicateOf) {
    items.push(row(none, <>Already tracked in <ExternalLink href={outcome.duplicateOf}>{issueLabel(outcome.duplicateOf)}</ExternalLink></>, "dup"))
  } else if ((outcome.decision === "issue" || outcome.decision === "fix") && !github.written) {
    items.push(row(none, <span className="text-muted-foreground">Nothing was written to GitHub, the server runs in shadow mode.</span>, "shadow"))
  }
  if (outcome.decision === "fix") {
    if (github.dispatched) {
      items.push(row(ok, "Codex fix workflow started. A draft pull request appears if the bug can be reproduced.", "fix"))
    } else if (github.dispatchError) {
      items.push(row(<WarningCircleIcon className="size-4 text-destructive" aria-hidden />, <span className="text-destructive">Could not start the fix workflow: {github.dispatchError}</span>, "fixerr"))
    }
  }
  items.push(
    row(
      crisp.segmentSet === false ? warn : ok,
      <>
        {crisp.segmentSet === false ? "Crisp refused the status segment " : "Conversation marked in Crisp as "}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">{crisp.segment}</code>
      </>,
      "segment"
    )
  )
  if (crisp.notePosted === false) {
    items.push(row(warn, <span className="text-muted-foreground">Crisp did not accept the private note (the plan does not allow API notes). Its text is below.</span>, "note"))
  }
  return <ul className="flex flex-col gap-1.5 text-sm">{items}</ul>
}

/** The side panel with everything about one conversation. */
export function CrispPanel({
  item,
  onClose,
  onToggleRead,
  busy,
}: {
  item: CrispTriageItem | null
  onClose: () => void
  onToggleRead: (item: CrispTriageItem) => void
  busy: boolean
}) {
  const outcome = item?.outcome ?? null
  const verdict = outcome?.verdict ?? null
  return (
    <Sheet open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        {item && (
          <>
            <SheetHeader className="gap-2 border-b pb-4">
              <div className="flex flex-wrap items-center gap-2 pr-8">
                <DecisionBadge item={item} />
                {verdict && <Badge variant="secondary" className="font-normal">{CATEGORY[verdict.category] ?? verdict.category}</Badge>}
                {verdict && verdict.category !== "spam" && (
                  <Badge variant="secondary" className={cn("font-normal", SEVERITY_TONE[verdict.severity])}>{verdict.severity}</Badge>
                )}
                {verdict && verdict.category !== "spam" && verdict.area !== "unknown" && (
                  <Badge variant="secondary" className="font-normal">{verdict.area}</Badge>
                )}
              </div>
              <SheetTitle className="text-sm leading-snug">{headline(item)}</SheetTitle>
              <SheetDescription>
                <Time iso={item.startedAt} />
                {outcome && RULE_WHY[outcome.rule] && <span className="mt-1 block">{RULE_WHY[outcome.rule]}</span>}
              </SheetDescription>
              <div className="flex flex-wrap gap-2 pt-1">
                {outcome && (
                  <Button variant="outline" size="sm" nativeButton={false} render={<a href={outcome.inboxUrl} target="_blank" rel="noreferrer" />}>
                    <ChatCircleDotsIcon />
                    Open in Crisp
                  </Button>
                )}
                <Button variant="outline" size="sm" disabled={busy} onClick={() => onToggleRead(item)}>
                  {item.read ? <EnvelopeSimpleIcon /> : <EnvelopeSimpleOpenIcon />}
                  {item.read ? "Mark as unread" : "Mark as read"}
                </Button>
              </div>
            </SheetHeader>

            <div className="flex flex-col gap-5 p-4 text-sm">
              {!outcome && (
                <Section title="What happened">
                  {item.error ? <p className="text-destructive">{item.error}</p> : <p className="text-muted-foreground">No details were recorded for this run.</p>}
                  <p className="text-xs text-muted-foreground">
                    The conversation is not marked in Crisp. Remove and add the trigger segment again to retry.
                  </p>
                </Section>
              )}

              {outcome?.decision === "answer" && (
                <Section title="Draft answer" action={outcome.answerDraft ? <CopyButton text={outcome.answerDraft} label="Copy draft" /> : undefined}>
                  {outcome.answerDraft ? (
                    <p className="rounded-md border bg-muted/40 p-3 leading-relaxed whitespace-pre-wrap">{outcome.answerDraft}</p>
                  ) : (
                    <p className="text-muted-foreground">No draft was written.</p>
                  )}
                </Section>
              )}

              {outcome?.decision === "needs_info" && outcome.questions.length > 0 && (
                <Section title="Ask the customer" action={<CopyButton text={outcome.questions.map((q) => `- ${q}`).join("\n")} label="Copy questions" />}>
                  <ul className="list-disc pl-5">
                    {outcome.questions.map((q, i) => (
                      <li key={i}>{q}</li>
                    ))}
                  </ul>
                </Section>
              )}

              {outcome && (
                <Section title="What the triage did">
                  <Results outcome={outcome} />
                </Section>
              )}

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

              {outcome && (
                <Section title="Private note" action={<CopyButton text={outcome.note} label="Copy note" />}>
                  <pre className="rounded-md border bg-muted/40 p-3 text-xs/relaxed break-words whitespace-pre-wrap">{outcome.note}</pre>
                </Section>
              )}

              <Section title="Technical">
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs">
                  {outcome && (
                    <>
                      <dt className="text-muted-foreground">Rule</dt>
                      <dd>{outcome.rule}</dd>
                      <dt className="text-muted-foreground">Mode</dt>
                      <dd>{outcome.mode}</dd>
                    </>
                  )}
                  {verdict && (
                    <>
                      <dt className="text-muted-foreground">Model</dt>
                      <dd>{verdict.model}</dd>
                      <dt className="text-muted-foreground">Confidence</dt>
                      <dd>{Math.round(verdict.confidence * 100)}%</dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">Conversation</dt>
                  <dd className="font-mono break-all">{item.sessionId}</dd>
                  <dt className="text-muted-foreground">Run</dt>
                  <dd>
                    <Link to="/runs/$id" params={{ id: item.id }} className="underline underline-offset-4">
                      open run and logs
                    </Link>
                  </dd>
                </dl>
              </Section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

export const CrispIcon = ChatCircleDotsIcon

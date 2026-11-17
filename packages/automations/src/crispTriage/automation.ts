import { defineAutomation, type Automation } from "@automation-server/core/automation";
import type { Event } from "@automation-server/core/event";
import { createCrispClient, CrispApiError } from "@automation-server/sources/crisp/client";
import { CRISP_SEGMENTS, isCrispSession, type CrispSessionEvent, type CustomerRequest } from "@automation-server/sources/crisp/event";

import { createGithubClient, GithubApiError } from "../github";
import { createOpenRouterClient } from "../openrouter";
import { buildOutcome, CRISP_LABEL, crispMarker, formatIssue, formatNote, scrubber, statusSegment, type Verdict } from "./format";
import { hasUserText, redactMessages, systemPrompt, userPrompt } from "./prompt";
import { applyMode, route } from "./route";
import { TRIAGE_VERSION, triageSchema, type Category, type Decision, type Mode, type Triage } from "./types";

export const CRISP_TRIAGE = "crisp-triage";

export type CrispTriageConfig = {
  crisp: { websiteId: string; identifier: string; key: string; apiBaseUrl?: string };
  openrouter: { apiKey: string; triageModel: string; escalationModel: string; apiBaseUrl?: string };
  github: { repo: { owner: string; name: string }; token: string; apiBaseUrl?: string } | null;
  triggerSegment: string;
  autoTriage: boolean;
  mode: Mode;
  minConfidence: number;
  areas: readonly string[];
  autofixAreas: readonly string[];
  workflowFile: string;
  fetch?: typeof fetch;
};

const ESCALATE: readonly Category[] = ["bug", "regression", "data_fix"];
const NO_USER_TEXT_QUESTION = "The customer has not described the problem yet. What were they trying to do and what happened?";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const hasStatus = (segments: readonly string[]) => segments.some((s) => s.trim().toLowerCase().startsWith("triage:"));

function actionable(err: unknown, repo: string, file: string): unknown {
  if (!(err instanceof GithubApiError)) return err;
  switch (err.status) {
    case 404:
      return new Error(`Workflow ${file} was not found in ${repo}, or the GitHub token cannot see it. Install it from the admin Workflows page. (${err.message})`);
    case 422:
      return new Error(`GitHub refused to dispatch ${file} in ${repo}: the installed workflow has no workflow_dispatch trigger. Reinstall it from the admin Workflows page. (${err.message})`);
    case 401:
    case 403:
      return new Error(`The GitHub token cannot dispatch workflows in ${repo}. It needs Actions: Read and write on that repository. (${err.message})`);
    default:
      return err;
  }
}

export function createCrispTriage(config: CrispTriageConfig): Automation {
  if (config.mode !== "shadow" && !config.github) throw new Error(`Crisp triage mode ${config.mode} needs the GitHub token and issues repository`);
  const crisp = createCrispClient({ ...config.crisp, fetch: config.fetch });
  const llm = createOpenRouterClient({ ...config.openrouter, fetch: config.fetch });
  const github = config.github ? createGithubClient({ ...config.github, fetch: config.fetch }) : null;
  const schema = triageSchema(config.areas);
  const repoName = config.github ? `${config.github.repo.owner}/${config.github.repo.name}` : "";

  const matches = (event: Event): event is CrispSessionEvent => {
    if (!isCrispSession(event)) return false;
    const { segments, request } = event.payload;
    if (hasStatus([...segments, ...(request?.segments ?? [])])) return false;
    if (event.kind === CRISP_SEGMENTS) return segments.some((s) => same(s, config.triggerSegment));
    return config.autoTriage;
  };

  const classify = async (model: string, user: string): Promise<Triage> =>
    llm.structured({ model, system: systemPrompt(config.areas), user, name: "triage", schema });

  async function decide(request: CustomerRequest): Promise<{ rule: string; decision: Decision; verdict: Verdict | null }> {
    const existing = github ? await github.findOpenIssueByMarker(CRISP_LABEL, crispMarker(request.sessionId)) : null;
    if (existing) return { rule: "duplicate", decision: { kind: "drop", reason: "duplicate", duplicateOf: existing }, verdict: null };
    if (!hasUserText(request)) {
      return { rule: "no_user_text", decision: { kind: "needs_info", questions: [NO_USER_TEXT_QUESTION] }, verdict: null };
    }
    const user = userPrompt(redactMessages(request));
    let model = config.openrouter.triageModel;
    let triage = await classify(model, user);
    if (triage.confidence < config.minConfidence || ESCALATE.includes(triage.category)) {
      model = config.openrouter.escalationModel;
      triage = await classify(model, user);
    }
    const { rule, decision } = route({ triage, minConfidence: config.minConfidence, autofixAreas: config.autofixAreas });
    return { rule, decision, verdict: { triage, model, rule } };
  }

  return defineAutomation({
    name: CRISP_TRIAGE,
    matches,
    async run(event, { log, report }) {
      const request = event.payload.request;
      if (!request) throw new Error("The Crisp conversation could not be loaded. Check the Crisp plugin key and its scopes.");
      const sessionId = request.sessionId;

      const { rule, decision: routed, verdict } = await decide(request);
      const { decision, github: writes } = applyMode(routed, config.mode);
      log.info("triaged", {
        sessionId,
        mode: config.mode,
        rule,
        decision: decision.kind,
        triageVersion: TRIAGE_VERSION,
        ...(verdict
          ? {
              model: verdict.model,
              category: verdict.triage.category,
              confidence: verdict.triage.confidence,
              severity: verdict.triage.severity,
              area: verdict.triage.area,
            }
          : {}),
      });

      let issueUrl: string | undefined;
      let issueRef: { number: number; url: string } | null = null;
      let dispatched = false;
      let dispatchError: unknown;
      if (writes && github && verdict && (decision.kind === "issue" || decision.kind === "fix")) {
        const issue = formatIssue(request, verdict, decision);
        await github.ensureLabels(issue.labels);
        const created = await github.createIssue(issue);
        issueUrl = created.html_url;
        issueRef = { number: created.number, url: created.html_url };
        log.info("created github issue", { sessionId, number: created.number, url: created.html_url });
        if (decision.kind === "fix") {
          try {
            await github.dispatchWorkflow(config.workflowFile, await github.defaultBranch(), { issue_number: String(created.number) });
            dispatched = true;
            log.info("dispatched workflow", { sessionId, number: created.number, workflow: config.workflowFile, repo: repoName });
          } catch (err) {
            dispatchError = actionable(err, repoName, config.workflowFile);
          }
        }
      }

      const note = formatNote({ decision, mode: config.mode, github: writes, verdict, issueUrl, dispatched, dispatchFailed: dispatchError !== undefined });
      const outcome = (notePosted: boolean | null, segmentSet: boolean | null) =>
        buildOutcome({
          request,
          mode: config.mode,
          rule,
          decision,
          verdict,
          github: writes,
          issue: issueRef,
          dispatched,
          dispatchError: dispatchError === undefined ? null : errorText(dispatchError),
          notePosted,
          segmentSet,
          note,
        });
      report?.(outcome(null, null));
      // A free Crisp plan refuses API writes with 402. That must not fail the triage: the verdict stays in the
      // admin (and in the GitHub issue), only the Crisp copy is skipped.
      const paidOnly = async (what: string, write: () => Promise<void>): Promise<boolean> => {
        try {
          await write();
          return true;
        } catch (err) {
          if (!(err instanceof CrispApiError) || err.status !== 402) throw err;
          log.warn("crisp refused the write, the plan does not include it", { sessionId, what });
          return false;
        }
      };
      const noted = await paidOnly("note", () => crisp.addNote(sessionId, note));
      if (!noted) log.info("triage note not posted to crisp", { sessionId, note: scrubber(request)(note) });
      const segment = statusSegment(decision);
      const segmented = await paidOnly("segments", async () => {
        const current = await crisp.conversation(sessionId);
        await crisp.setSegments(sessionId, [...new Set([...current.segments, segment])]);
      });
      report?.(outcome(noted, segmented));
      log.info("finished crisp write-back", { sessionId, segment, noted, segmented });
      if (dispatchError !== undefined) throw dispatchError;
    },
  });
}

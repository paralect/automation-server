import { defineAutomation } from "@automation-server/core/automation";
import { createCrispClient, CrispApiError } from "@automation-server/sources/crisp/client";
import { CRISP_SEGMENTS, isCrispSession } from "@automation-server/sources/crisp/event";
import { createGithubClient, GithubApiError } from "../github";
import { createOpenRouterClient } from "../openrouter";
import { buildOutcome, CRISP_LABEL, crispMarker, formatIssue, formatNote, scrubber, statusSegment } from "./format";
import { hasUserText, redactMessages, systemPrompt, userPrompt } from "./prompt";
import { applyMode, route } from "./route";
import { TRIAGE_VERSION, triageSchema } from "./types";
export const CRISP_TRIAGE = "crisp-triage";
const ESCALATE = ["bug", "regression", "data_fix"];
const NO_USER_TEXT_QUESTION = "The customer has not described the problem yet. What were they trying to do and what happened?";
const errorText = (err) => (err instanceof Error ? err.message : String(err));
const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
const hasStatus = (segments) => segments.some((s) => s.trim().toLowerCase().startsWith("triage:"));
function actionable(err, repo, file) {
    if (!(err instanceof GithubApiError))
        return err;
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
export function createCrispTriage(config) {
    if (config.mode !== "shadow" && !config.github)
        throw new Error(`Crisp triage mode ${config.mode} needs the GitHub token and issues repository`);
    const crisp = createCrispClient({ ...config.crisp, fetch: config.fetch });
    const llm = createOpenRouterClient({ ...config.openrouter, fetch: config.fetch });
    const github = config.github ? createGithubClient({ ...config.github, fetch: config.fetch }) : null;
    const schema = triageSchema(config.areas);
    const repoName = config.github ? `${config.github.repo.owner}/${config.github.repo.name}` : "";
    const matches = (event) => {
        if (!isCrispSession(event))
            return false;
        const { segments, request } = event.payload;
        if (hasStatus([...segments, ...(request?.segments ?? [])]))
            return false;
        if (event.kind === CRISP_SEGMENTS)
            return segments.some((s) => same(s, config.triggerSegment));
        return config.autoTriage;
    };
    const classify = async (model, user) => llm.structured({ model, system: systemPrompt(config.areas), user, name: "triage", schema });
    async function decide(request) {
        const existing = github ? await github.findOpenIssueByMarker(CRISP_LABEL, crispMarker(request.sessionId)) : null;
        if (existing)
            return { rule: "duplicate", decision: { kind: "drop", reason: "duplicate", duplicateOf: existing }, verdict: null };
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
        async run(event, { log, report, dryRun = false }) {
            const request = event.payload.request;
            if (!request)
                throw new Error("The Crisp conversation could not be loaded. Check the Crisp plugin key and its scopes.");
            const sessionId = request.sessionId;
            const { rule, decision: routed, verdict } = await decide(request);
            const { decision, github: writes } = applyMode(routed, config.mode);
            log.info("triaged", {
                sessionId,
                mode: config.mode,
                ...(dryRun ? { dryRun } : {}),
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
            let issueUrl;
            let issueRef = null;
            let dispatched = false;
            let dispatchError;
            let wouldIssue = null;
            if (writes && verdict && (decision.kind === "issue" || decision.kind === "fix")) {
                const issue = formatIssue(request, verdict, decision);
                if (dryRun) {
                    wouldIssue = { title: issue.title, labels: issue.labels };
                    log.info("dry-run: would create github issue", { sessionId, title: issue.title, labels: issue.labels });
                    if (decision.kind === "fix")
                        log.info("dry-run: would dispatch workflow", { sessionId, workflow: config.workflowFile, repo: repoName });
                }
                else if (github) {
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
                        }
                        catch (err) {
                            dispatchError = actionable(err, repoName, config.workflowFile);
                        }
                    }
                }
            }
            const note = formatNote({ decision, mode: config.mode, github: writes, verdict, issueUrl, dispatched, dispatchFailed: dispatchError !== undefined, dryRun });
            const outcome = (notePosted, segmentSet) => buildOutcome({
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
                ...(dryRun ? { wouldDo: { issue: wouldIssue, dispatch: wouldIssue !== null && decision.kind === "fix" } } : {}),
            });
            if (dryRun) {
                log.info("dry-run: would post note", { sessionId, note: scrubber(request)(note) });
                log.info("dry-run: would set segment", { sessionId, segment: statusSegment(decision) });
                report?.(outcome(false, false));
                return;
            }
            report?.(outcome(null, null));
            // A free Crisp plan refuses API writes with 402. That must not fail the triage: the verdict stays in the
            // admin (and in the GitHub issue), only the Crisp copy is skipped.
            const paidOnly = async (what, write) => {
                try {
                    await write();
                    return true;
                }
                catch (err) {
                    if (!(err instanceof CrispApiError) || err.status !== 402)
                        throw err;
                    log.warn("crisp refused the write, the plan does not include it", { sessionId, what });
                    return false;
                }
            };
            const noted = await paidOnly("note", () => crisp.addNote(sessionId, note));
            if (!noted)
                log.info("triage note not posted to crisp", { sessionId, note: scrubber(request)(note) });
            const segment = statusSegment(decision);
            const segmented = await paidOnly("segments", async () => {
                const current = await crisp.conversation(sessionId);
                await crisp.setSegments(sessionId, [...new Set([...current.segments, segment])]);
            });
            report?.(outcome(noted, segmented));
            log.info("finished crisp write-back", { sessionId, segment, noted, segmented });
            if (dispatchError !== undefined)
                throw dispatchError;
        },
    });
}

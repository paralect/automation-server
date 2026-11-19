import type { PendingAction, PendingActionStore } from "@automation-server/core/pendingActions";

import { redactUntrusted, singleLine, truncate } from "../redact";
import type { Agent, Proposal, StepLog } from "./agent";
import {
  approvalMessage,
  APPROVAL_TTL_MS,
  CANCELLED_REPLY,
  EXPIRED_REPLY,
  NOTHING_WAITING_REPLY,
  onlyRequesterReply,
  parseDecision,
  type Decision,
} from "./approval";
import type { SlackBotHandler, SlackBotHandlerInput, SlackBotHandlerResult } from "./automation";
import { escapeSlackText, type SlackBotClient, type SlackIdentity } from "./client";
import { THREAD_LIMIT, toThreadMessages, type ThreadMessage } from "./thread";
import { createToolRegistry, executeTool, type ToolRegistry } from "./tools/registry";
import type { AnyTool } from "./tools/types";

export const EMPTY_QUESTION_REPLY = "Tell me what you need, for example: what Linear issues mention billing?";
export const NO_WRITES_REPLY = "I could not do that: changes are not enabled for this bot.";

const MAX_LOGGED_ARGS_CHARS = 200;
const MAX_RESULT_CHARS = 1500;

export type ApprovalConfig = {
  readonly pending: PendingActionStore;
  // The same tools the agent was built with. They are looked up again at approval time, so an integration removed since the proposal cannot run.
  readonly tools: readonly AnyTool[];
  readonly project: string;
  readonly requireApproval: boolean;
  // Shown in "@name approve". Falls back to the Slack bot's own name.
  readonly botName?: string;
  readonly now?: () => number;
  readonly ttlMs?: number;
};

// The thread is context only. A missing scope or a deleted message must not stop the bot from answering the question itself.
async function readThread(client: SlackBotClient, channel: string, threadTs: string, excludeTs: string, identity: () => Promise<SlackIdentity>): Promise<ThreadMessage[]> {
  const [raw, { botUserId }] = await Promise.all([client.replies({ channel, threadTs, limit: THREAD_LIMIT }), identity()]);
  return toThreadMessages(raw, { botUserId, excludeTs });
}

const clip = (text: string, max: number) => truncate(singleLine(redactUntrusted(text)), max);

const argsLog = (args: unknown) => clip(JSON.stringify(args) ?? "", MAX_LOGGED_ARGS_CHARS);

const writeStep = (tool: string, args: unknown, stage: StepLog["stage"], ok: boolean, started: number, error?: string): StepLog => ({
  index: 1,
  tool,
  args: argsLog(args),
  ok,
  durationMs: Date.now() - started,
  stage,
  ...(error ? { error: clip(error, 200) } : {}),
});

export function createAgentHandler(agent: Agent, approvals?: ApprovalConfig): SlackBotHandler {
  const identities = new WeakMap<SlackBotClient, Promise<SlackIdentity>>();
  const identityOf = (client: SlackBotClient) => () => {
    let cached = identities.get(client);
    if (!cached) {
      cached = client.authTest();
      cached.catch(() => identities.delete(client));
      identities.set(client, cached);
    }
    return cached;
  };

  const registry: ToolRegistry | null = approvals ? createToolRegistry(approvals.tools) : null;
  const now = approvals?.now ?? Date.now;

  const botNameFor = async (client: SlackBotClient): Promise<string> => {
    if (approvals?.botName) return approvals.botName;
    return identityOf(client)()
      .then((i) => i.botName)
      .catch(() => "bot");
  };

  async function execute(action: Pick<PendingAction, "tool" | "args" | "requestedBy" | "channel" | "threadTs">, dryRun: boolean): Promise<{ ok: boolean; text: string }> {
    const tool = registry?.get(action.tool);
    if (!tool || tool.kind !== "write") return { ok: false, text: `${action.tool} is no longer available. Its integration may have been turned off.` };
    const result = await executeTool(tool, action.args, { requestedBy: action.requestedBy, channel: action.channel, threadTs: action.threadTs, dryRun });
    return result.ok ? { ok: true, text: result.text } : { ok: false, text: result.error };
  }

  const reportExecution = (outcome: { ok: boolean; text: string }) => {
    const text = escapeSlackText(truncate(outcome.text, MAX_RESULT_CHARS));
    return outcome.ok ? `Done. ${text}` : `I could not do that: ${text}`;
  };

  async function decide(decision: Decision, { event, ctx }: SlackBotHandlerInput, config: ApprovalConfig): Promise<SlackBotHandlerResult> {
    const { channel, user, ts, threadTs } = event.payload;
    const thread = threadTs ?? ts;
    const { pending, project } = config;
    const dryRun = ctx.dryRun === true;

    const action = pending.findPendingForThread(project, channel, thread);
    if (!action) return { reply: NOTHING_WAITING_REPLY, status: "answered" };
    if (action.requestedBy !== user) return { reply: onlyRequesterReply(action.requestedBy, decision), status: "answered" };

    if (now() >= action.expiresAt) {
      if (!dryRun) pending.transition(action.id, "pending", "expired");
      return { reply: EXPIRED_REPLY, status: "expired" };
    }

    const started = Date.now();
    if (dryRun) {
      const outcome = decision === "approve" ? await execute(action, true) : { ok: true, text: `dry-run: would cancel ${action.tool}` };
      return { reply: escapeSlackText(outcome.text), status: decision === "approve" ? "executed" : "cancelled", steps: [writeStep(action.tool, action.args, decision === "approve" ? "executed" : "cancelled", outcome.ok, started)] };
    }

    if (decision === "cancel") {
      if (!pending.transition(action.id, "pending", "cancelled")) return { reply: NOTHING_WAITING_REPLY, status: "answered" };
      return { reply: CANCELLED_REPLY, status: "cancelled", steps: [writeStep(action.tool, action.args, "cancelled", true, started)] };
    }

    // The compare and set is the only gate: two approvals racing both get here, exactly one wins and runs the tool.
    if (!pending.transition(action.id, "pending", "approved")) return { reply: NOTHING_WAITING_REPLY, status: "answered" };
    const outcome = await execute(action, false);
    const resultText = clip(outcome.text, MAX_RESULT_CHARS);
    try {
      pending.transition(action.id, "approved", outcome.ok ? "executed" : "failed", resultText);
    } catch (err) {
      // The write already ran. A store closed by shutdown must not swallow the reply that tells the person so.
      ctx.log.warn("could not record the outcome of an approved action", { actionId: action.id, tool: action.tool, reason: clip(err instanceof Error ? err.message : String(err), 200) });
    }
    return {
      reply: reportExecution(outcome),
      status: outcome.ok ? "executed" : "failed",
      ...(outcome.ok ? {} : { error: clip(outcome.text, 300) }),
      steps: [writeStep(action.tool, action.args, "executed", outcome.ok, started, outcome.ok ? undefined : outcome.text)],
    };
  }

  async function propose(proposal: Proposal, steps: readonly StepLog[], { event, ctx, client }: SlackBotHandlerInput, config: ApprovalConfig | undefined): Promise<SlackBotHandlerResult> {
    const { team, channel, user, ts, threadTs } = event.payload;
    if (!config) return { reply: NO_WRITES_REPLY, status: "failed", error: "writes are not enabled", steps };
    const dryRun = ctx.dryRun === true;
    const started = Date.now();

    if (!config.requireApproval) {
      const outcome = await execute({ ...proposal, requestedBy: user, channel, threadTs: threadTs ?? ts }, dryRun);
      const logged = steps.map((s) => (s.stage === "proposed" ? { ...s, stage: "executed" as const, ok: outcome.ok, durationMs: s.durationMs + Date.now() - started } : s));
      return {
        reply: reportExecution(outcome),
        status: outcome.ok ? "executed" : "failed",
        ...(outcome.ok ? {} : { error: clip(outcome.text, 300) }),
        steps: logged,
      };
    }

    const at = now();
    if (!dryRun) {
      config.pending.expireOlderThan(at);
      config.pending.create({ project: config.project, team, channel, threadTs: threadTs ?? ts, requestedBy: user, tool: proposal.tool, args: proposal.args, expiresAt: at + (config.ttlMs ?? APPROVAL_TTL_MS) });
    }
    const botName = await botNameFor(client);
    return { reply: approvalMessage({ tool: proposal.tool, args: proposal.args, botName, requestedBy: user }), status: "pending-approval", steps };
  }

  return async (input): Promise<SlackBotHandlerResult> => {
    const { event, ctx, client } = input;
    const { channel, user, text, ts, threadTs } = event.payload;
    if (text.trim() === "") return { reply: EMPTY_QUESTION_REPLY, steps: [], status: "answered" };

    const decision = approvals ? parseDecision(text) : null;
    if (decision && approvals) return decide(decision, input, approvals);

    let thread: ThreadMessage[] = [];
    if (threadTs !== null) {
      try {
        thread = await readThread(client, channel, threadTs, ts, identityOf(client));
      } catch (err) {
        const reason = clip(err instanceof Error ? err.message : String(err), 200);
        ctx.log.warn("could not read the thread, answering without it", { channel, threadTs, reason });
      }
    }
    const result = await agent.run({ question: text, user, thread }, { requestedBy: user, channel, threadTs: threadTs ?? ts, dryRun: ctx.dryRun === true });
    if (result.status === "pending-approval") return propose(result.proposal, result.steps, input, approvals);
    return result;
  };
}

import type { Spec } from "@json-render/core";

import { renderCard, type SlackMessage } from "./card";
import { escapeSlackText } from "./client";

export const APPROVAL_MINUTES = 10;
export const APPROVAL_TTL_MS = APPROVAL_MINUTES * 60_000;

export const NOTHING_WAITING_REPLY = "Nothing is waiting for approval in this thread.";
export const EXPIRED_REPLY = "This request expired.";
export const CANCELLED_REPLY = "Cancelled. Nothing was changed.";

export type Decision = "approve" | "cancel";

const WORDS: Readonly<Record<string, Decision>> = {
  approve: "approve",
  yes: "approve",
  да: "approve",
  подтверждаю: "approve",
  cancel: "cancel",
  no: "cancel",
  нет: "cancel",
  отмена: "cancel",
};

// Exact words only. A sentence that merely contains one is a normal request for the model, so "yes please create it twice" can never approve anything.
export function parseDecision(text: string): Decision | null {
  const word = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").trim();
  return Object.hasOwn(WORDS, word) ? WORDS[word]! : null;
}

const MEMBER_ID = /^[UW][A-Z0-9]{1,20}$/;

// The only live mention the bot writes. It is built from the Slack-validated requester ID, never from model or tool text, and an ID of any other shape is shown as inert text.
export const mentionMember = (id: string): string => (MEMBER_ID.test(id) ? `<@${id}>` : escapeSlackText(id));

// Inside a code block only a backtick could break out, so each one gets an invisible joiner after it. Angle brackets and ampersands are escaped like all other text.
const inert = (text: string) => escapeSlackText(text).replace(/`/g, "`​");

const label = (name: string) => inert(name.replace(/[\r\n]+/g, " ").trim()) || "bot";

export type ApprovalMessage = {
  readonly tool: string;
  readonly args: unknown;
  readonly botName: string;
  readonly requestedBy: string;
};

// A Slack section holds 3000 characters, so long arguments are split over several code blocks. Every character is still shown.
const ARGS_CHUNK_CHARS = 2800;

const instructions = (botName: string, requestedBy: string) => {
  const bot = label(botName);
  return `Reply \`@${bot} approve\` or \`@${bot} cancel\` in this thread within ${APPROVAL_MINUTES} minutes. Only ${mentionMember(requestedBy)} can approve.`;
};

export function approvalMessage({ tool, args, botName, requestedBy }: ApprovalMessage): string {
  return [`I need approval to run \`${inert(tool)}\` with exactly these arguments:`, "```", inert(JSON.stringify(args, null, 2) ?? "{}"), "```", instructions(botName, requestedBy)].join("\n");
}

// The same request as a card. Its text is approvalMessage, so notifications and the thread history read the same.
export function approvalCard(request: ApprovalMessage): SlackMessage {
  // The card renderer turns **x** into *x*, even inside a code block. An invisible space between the asterisks keeps the arguments exactly as they run.
  const json = inert(JSON.stringify(request.args, null, 2) ?? "{}").replace(/\*\*/g, "*\u200b*");
  const chunks: string[] = [];
  for (let i = 0; i < json.length; i += ARGS_CHUNK_CHARS) chunks.push(json.slice(i, i + ARGS_CHUNK_CHARS));
  const argIds = chunks.map((_, i) => `args${i}`);
  const elements: Record<string, unknown> = {
    card: { type: "Card", props: { title: "Approval needed" }, children: ["intro", ...argIds, "how"] },
    intro: { type: "Text", props: { content: `I need approval to run \`${inert(request.tool)}\` with exactly these arguments:` }, children: [] },
    how: { type: "Text", props: { content: instructions(request.botName, request.requestedBy), style: "muted" }, children: [] },
  };
  chunks.forEach((chunk, i) => (elements[`args${i}`] = { type: "Text", props: { content: `\`\`\`\n${chunk}\n\`\`\`` }, children: [] }));
  const text = approvalMessage(request);
  try {
    return { text, blocks: renderCard({ root: "card", elements } as unknown as Spec, { untrusted: false }).blocks };
  } catch {
    // Too many chunks for one message: the plain text still carries every argument.
    return { text, blocks: [] };
  }
}

export const onlyRequesterReply = (requestedBy: string, decision: Decision): string => `Only ${escapeSlackText(requestedBy)} can ${decision} this.`;

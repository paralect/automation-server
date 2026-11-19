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

export function approvalMessage({ tool, args, botName, requestedBy }: ApprovalMessage): string {
  const bot = label(botName);
  return [
    `I need approval to run \`${inert(tool)}\` with exactly these arguments:`,
    "```",
    inert(JSON.stringify(args, null, 2) ?? "{}"),
    "```",
    `Reply \`@${bot} approve\` or \`@${bot} cancel\` in this thread within ${APPROVAL_MINUTES} minutes. Only ${mentionMember(requestedBy)} can approve.`,
  ].join("\n");
}

export const onlyRequesterReply = (requestedBy: string, decision: Decision): string => `Only ${escapeSlackText(requestedBy)} can ${decision} this.`;

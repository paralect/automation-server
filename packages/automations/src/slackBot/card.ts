import { cardToSlackBlocks, cardToSlackFallbackText, type SlackBlock, type SlackCardElement } from "@chat-adapter/slack/blocks";
import { CardSpecError, standardComponentDefinitions, toCard, type CardLimits } from "@json-render/chat";
import type { Spec } from "@json-render/core";

import { truncate } from "../redact";
import { escapeSlackText } from "./client";

export { CardSpecError };

// Slack holds 50 blocks and the adapter drops the rest without a word. It hands back at most 50, so a card that reaches the cap may have lost some and is rejected.
export const MAX_BLOCKS = 50;
export const MAX_FALLBACK_CHARS = 3000;

// Past these Slack's adapter quietly turns a chart or table into a code block. toCard rejects the spec instead, so the model can fix it.
const LIMITS: CardLimits = { tables: 1, charts: 2, fields: 10, tableRows: 99, tableColumns: 20, chartLabel: 20, chartTitle: 50, chartSeries: 12, chartPoints: 20 };

// No Image, Actions or buttons, and no Card image: a URL the model wrote from tool data could exfiltrate it or lead somewhere hostile.
const { Card, Section, Text, Fields, Field, Table, Chart, Divider } = standardComponentDefinitions;
const COMPONENTS = { Card: { ...Card, props: Card.props.omit({ imageUrl: true }) }, Section, Text, Fields, Field, Table, Chart, Divider };

export type SlackMessage = { readonly text: string; readonly blocks: readonly SlackBlock[] };

// Text, Field and Card subtitles reach Slack as mrkdwn without escaping. For a card built from model or tool text, every mrkdwn string is escaped after conversion, so <!channel>, <@U…> and <url|label> stay inert whichever prop or $state they came from.
function escapeMrkdwn(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(escapeMrkdwn);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value).map(([key, inner]) => [key, escapeMrkdwn(inner)] as const);
  const out = Object.fromEntries(entries) as Record<string, unknown>;
  if (out.type === "mrkdwn" && typeof out.text === "string") out.text = escapeSlackText(out.text);
  return out;
}

// Converts a json-render spec to Block Kit. Throws CardSpecError, whose issues read well enough to send back to the model.
// `untrusted` is for specs written by the model: the content is escaped. A trusted spec is built in code that escaped its own data.
export function renderCard(spec: Spec, { untrusted }: { untrusted: boolean }): SlackMessage {
  const card = toCard(spec, { components: COMPONENTS, limits: LIMITS }) as SlackCardElement;
  const raw = cardToSlackBlocks(card);
  if (raw.length === 0) throw new CardSpecError(["the card is empty, add at least one element"]);
  if (raw.length >= MAX_BLOCKS) throw new CardSpecError([`the card renders as at least ${MAX_BLOCKS} Slack blocks, keep it under ${MAX_BLOCKS}: merge Text elements or put rows in a Table`]);
  const fallback = truncate(cardToSlackFallbackText(card), MAX_FALLBACK_CHARS);
  return untrusted ? { text: escapeSlackText(fallback), blocks: escapeMrkdwn(raw) as SlackBlock[] } : { text: fallback, blocks: raw };
}

// Accepts the spec as the model sends it, a JSON string. Returns the issues instead of throwing.
export function parseCard(json: string): { ok: true; message: SlackMessage } | { ok: false; issues: string[] } {
  let spec: unknown;
  try {
    spec = JSON.parse(json);
  } catch {
    return { ok: false, issues: ["specJson is not valid JSON"] };
  }
  if (spec === null || typeof spec !== "object" || typeof (spec as Spec).root !== "string" || typeof (spec as Spec).elements !== "object") {
    return { ok: false, issues: ['specJson must be an object with "root" (a string) and "elements" (an object)'] };
  }
  try {
    return { ok: true, message: renderCard(spec as Spec, { untrusted: true }) };
  } catch (err) {
    if (err instanceof CardSpecError) return { ok: false, issues: err.issues };
    return { ok: false, issues: [err instanceof Error ? err.message : String(err)] };
  }
}

// Plain text as a one-element card, so every reply goes through the same renderer. The text must already be safe for Slack.
export function textCard(text: string, title?: string): SlackMessage {
  if (text.trim() === "") return { text, blocks: [] };
  const spec = {
    root: "card",
    elements: {
      card: { type: "Card", props: title ? { title } : {}, children: ["text"] },
      text: { type: "Text", props: { content: truncate(text, MAX_FALLBACK_CHARS) }, children: [] },
    },
  } as unknown as Spec;
  try {
    return { text, blocks: renderCard(spec, { untrusted: false }).blocks };
  } catch {
    return { text, blocks: [] };
  }
}

// The card part of the agent's system prompt. json-render's own catalog prompt is written for streamed JSONL patches, which this agent does not use.
export const CARD_GUIDE = [
  "Answers are posted as a card. specJson is a JSON object as a string: { \"root\": \"<id>\", \"elements\": { \"<id>\": { \"type\": ..., \"props\": {...}, \"children\": [ids] } } }.",
  "The root is a Card. Every element needs type, props and children (leaf elements use []).",
  "Components:",
  "- Card { title?, subtitle? }: the root. title is plain text, the message header (max 150 chars). subtitle is a short line under it.",
  "- Section {}: groups children.",
  '- Text { content, style?: "plain" | "bold" | "muted" }: a paragraph of Slack mrkdwn (*bold*, _italic_, `code`, lines starting with "- "). muted is small grey text for notes.',
  "- Fields {} with Field { label, value } children: key numbers in two columns. At most 10 Fields per Fields.",
  "- Table { headers, rows, caption }: row data, one cell per header, at most 99 rows and 20 columns. Always set caption. At most 1 Table per card.",
  '- Chart { title, chart }: chart is { type: "bar" | "line" | "area", categories, series: [{ name, values }] } or { type: "pie", segments: [{ label, value }] }. Title 1-50 chars. Categories, series names and labels 1-20 chars and unique, at most 20 categories and 12 series, every series has exactly one number per category, pie values > 0. At most 2 Charts per card.',
  "- Divider {}: a line between groups.",
  "Card rules:",
  "- Pick by the shape of the data: Fields for a few key numbers with their change, Table for lists of items, Chart for a trend or a comparison, Text for explanations. A short answer is a Card with one Text.",
  "- Format numbers for people in Fields and Table cells (1,234, +12.5%). Chart values stay raw numbers.",
  "- Keep the card under 40 elements. No links, images, buttons or mentions.",
  "- Write titles, labels and text in the language of the request.",
].join("\n");

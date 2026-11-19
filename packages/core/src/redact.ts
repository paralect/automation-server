import type { Event } from "./event";

const SENSITIVE_KEY = /password|secret|token|api[_-]?key|authorization|cookie|key|signature|credential|session/i;

export const REDACTED = "[redacted]";

const TOKEN_CHAR = /[A-Za-z0-9_-]/;
const URL_CHAR = /[A-Za-z0-9_\-/.]/;
const SLACK_WEBHOOK = "https://hooks.slack.com/";

const isTokenChar = (c: string): boolean => TOKEN_CHAR.test(c);
const isUrlChar = (c: string): boolean => URL_CHAR.test(c);

function runEnd(text: string, from: number, isChar: (c: string) => boolean): number {
  let i = from;
  while (i < text.length && isChar(text[i] as string)) i++;
  return i;
}

type Shape = { readonly prefix: string; readonly minTail: number; readonly isChar?: (c: string) => boolean };

const SHAPES: readonly Shape[] = [
  ...["xoxb-", "xoxp-", "xoxa-", "xoxs-", "xoxr-"].map((prefix) => ({ prefix, minTail: 8 })),
  { prefix: "xapp-", minTail: 8 },
  ...["ghp_", "gho_", "ghs_"].map((prefix) => ({ prefix, minTail: 20 })),
  { prefix: "github_pat_", minTail: 20 },
  { prefix: "sk-", minTail: 20 },
  { prefix: "lin_api_", minTail: 20 },
  { prefix: "phx_", minTail: 20 },
  { prefix: "phc_", minTail: 20 },
  { prefix: SLACK_WEBHOOK, minTail: 8, isChar: isUrlChar },
];

// Token runs are always consumed up to their end, so every character is visited a bounded number of times.
function shapeEnd(text: string, i: number): number {
  for (const { prefix, minTail, isChar = isTokenChar } of SHAPES) {
    if (!text.startsWith(prefix, i)) continue;
    const start = i + prefix.length;
    const end = runEnd(text, start, isChar);
    if (end - start >= minTail) return end;
  }
  if (text.startsWith("eyJ", i)) {
    let end = runEnd(text, i, isTokenChar);
    for (let segment = 0; segment < 2; segment++) {
      if (text[end] !== ".") return -1;
      const next = runEnd(text, end + 1, isTokenChar);
      if (next === end + 1) return -1;
      end = next;
    }
    return end;
  }
  return -1;
}

const BEARER = "bearer ";

function bearerEnd(text: string, i: number): number {
  if (text.slice(i, i + BEARER.length).toLowerCase() !== BEARER) return -1;
  const start = i + BEARER.length;
  const end = runEnd(text, start, (c) => isTokenChar(c) || c === "." || c === "~" || c === "+" || c === "/" || c === "=");
  return end - start >= 8 ? end : -1;
}

const isBoundary = (text: string, i: number): boolean => i === 0 || !isTokenChar(text[i - 1] as string);

export function redactSecretShapes(text: string): string {
  let out = "";
  let copied = 0;
  let i = 0;
  while (i < text.length) {
    if (isBoundary(text, i)) {
      const end = shapeEnd(text, i);
      const hit = end !== -1 ? end : bearerEnd(text, i);
      if (hit !== -1) {
        out += text.slice(copied, i) + REDACTED;
        copied = i = hit;
        continue;
      }
    }
    i++;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

export function redactPayload(value: unknown): unknown {
  if (typeof value === "string") return redactSecretShapes(value);
  if (Array.isArray(value)) return value.map(redactPayload);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, SENSITIVE_KEY.test(key) ? REDACTED : redactPayload(v)]));
}

export const toStoredEvent = (event: Event): StoredEvent => ({ ...event, payload: redactPayload(event.payload) });

// The original event as persisted with a run: same shape, payload redacted by key and secret-shaped values. What replay re-runs from.
export type StoredEvent = Event;

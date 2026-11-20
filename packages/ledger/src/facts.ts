import type { LlmCall, MicroUsd } from "./types";

// What a GitHub write did, in the client's words. The inputs ride along in memory only: the observer reduces them to a
// work key, because they can hold 60k characters of untrusted text.
export type GithubEffect =
  | { readonly kind: "issue_created"; readonly repo: string; readonly number: number; readonly url: string }
  | {
      readonly kind: "workflow_dispatched";
      readonly repo: string;
      readonly workflowFile: string;
      readonly ref: string;
      readonly inputs: Readonly<Record<string, string>>;
      // Set when GitHub answered the dispatch with run details.
      readonly workflowRunId: number | null;
    };

// Clients call it after a successful remote call. An implementation must never throw.
export type Observer = {
  llm(call: LlmCall): void;
  github(effect: GithubEffect): void;
};

// Passing this is the explicit choice not to record: tests, connection checks, read-only clients.
export const UNOBSERVED: Observer = { llm: () => {}, github: () => {} };

export const MICROS_PER_USD = 1_000_000;

export const isMicroUsd = (value: number): value is MicroUsd => Number.isSafeInteger(value) && value >= 0;

export function microUsd(value: number): MicroUsd {
  if (!isMicroUsd(value)) throw new Error(`invalid micro-dollar amount: ${value}`);
  return value;
}

// The parse boundary for money: dollars arrive as a float and leave as integer micro-dollars.
export const toMicroUsd = (usd: number): MicroUsd => microUsd(Math.round(usd * MICROS_PER_USD));

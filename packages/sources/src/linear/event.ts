import type { Event } from "@automation-server/core/event";

export const LINEAR_SOURCE = "linear";
export const LINEAR_ISSUE = "issue";

export type LinearLabel = { readonly id: string; readonly name: string };

export type LinearIssue = {
  readonly action: "create" | "update";
  readonly issueId: string;
  readonly identifier: string;
  readonly title: string;
  readonly description: string;
  readonly url: string;
  readonly teamKey: string | null;
  readonly state: string | null;
  readonly labels: readonly LinearLabel[];
  readonly addedLabelIds: readonly string[];
  readonly updatedAt: string;
};

export type LinearIssueEvent = Event<LinearIssue, typeof LINEAR_ISSUE>;

export function isLinearIssue(event: Event): event is LinearIssueEvent {
  return event.source === LINEAR_SOURCE && event.kind === LINEAR_ISSUE;
}

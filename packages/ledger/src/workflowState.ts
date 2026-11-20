import { WORKFLOW_STATES, type WorkflowState } from "./types";

export const isWorkflowState = (value: string): value is WorkflowState => WORKFLOW_STATES.some((s) => s === value);

// GitHub splits a run's lifecycle into `status` and, once completed, `conclusion`. Everything downstream needs one value.
export function toWorkflowState(status: string | null | undefined, conclusion: string | null | undefined): WorkflowState {
  if (status !== "completed") {
    if (status === "in_progress") return "running";
    if (status === "waiting") return "waiting";
    return "queued";
  }
  switch (conclusion) {
    case "success":
    case "neutral":
      return "success";
    case "cancelled":
      return "cancelled";
    case "skipped":
    case "stale":
      return "skipped";
    case "action_required":
      return "waiting";
    default:
      return "failure";
  }
}

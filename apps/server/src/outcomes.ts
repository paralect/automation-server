import type { OutcomesAdmin } from "@automation-server/api/context";
import type { Job, Scheduler } from "@automation-server/core";
import { OUTCOME_SYNC_JOB } from "@automation-server/ledger/server";

export type OutcomesAdminDeps = {
  scheduler: Pick<Scheduler, "runNow">;
  jobs: (project: string) => readonly Job[];
  now?: () => Date;
};

// Sync now runs the project's own outcome-sync job under a fresh key, the same path as PostHog's Send now, so it shows on the Runs page.
export function createOutcomesAdmin({ scheduler, jobs, now = () => new Date() }: OutcomesAdminDeps): OutcomesAdmin {
  return {
    async syncNow(project) {
      const job = jobs(project).find((j) => j.name === OUTCOME_SYNC_JOB);
      if (!job) return { status: "not-configured", message: "Outcome sync needs the GitHub token. Set it in the GitHub integration." };
      const result = await scheduler.runNow(job, `manual:${now().toISOString()}`);
      switch (result.status) {
        case "succeeded":
          return { status: "succeeded", runId: result.runId, message: "Codex PRs and workflow runs are up to date" };
        case "failed":
          return { status: "failed", runId: result.runId, message: result.error };
        default:
          return { status: "busy", message: `An ${OUTCOME_SYNC_JOB} run is already in progress` };
      }
    },
  };
}

import type { ReplayAdmin } from "@automation-server/api/context";
import type { Dispatcher, Job, Scheduler } from "@automation-server/core";

export type ReplayAdminDeps = {
  dispatcher: Pick<Dispatcher, "replay">;
  scheduler: Pick<Scheduler, "runNow">;
  jobs: (project: string) => readonly Job[];
};

export function createReplayAdmin({ dispatcher, scheduler, jobs }: ReplayAdminDeps): ReplayAdmin {
  return {
    event: (request) => dispatcher.replay(request),
    // The admin client times out after 10 s and a job can take longer, so answer as soon as the run row exists.
    job(project, automation, key, replayOf) {
      const job = jobs(project).find((j) => j.name === automation);
      if (!job) return Promise.resolve({ status: "unknown-job" });
      return new Promise((resolve, reject) => {
        scheduler.runNow(job, key, { replayOf, onStarted: (runId) => resolve({ status: "started", runId }) }).then((result) => {
          if (result.status === "succeeded" || result.status === "failed") resolve({ status: "started", runId: result.runId });
          else resolve({ status: result.status });
        }, reject);
      });
    },
  };
}

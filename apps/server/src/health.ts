import type { Job } from "@automation-server/core";
import type { ConnectionTestResult, HealthStore, IntegrationId, StoredHealth } from "@automation-server/settings";

export const TOKEN_HEALTH_JOB = "token-health";
const CHECK_HOUR_UTC = 6;

export type HealthSink = {
  record(project: string, id: IntegrationId, result: ConnectionTestResult, now: Date): Promise<void>;
};

export type HealthNotifier = (project: string, id: IntegrationId, previous: StoredHealth | undefined, current: StoredHealth, now: Date) => Promise<void>;

export function createHealthSink({ store, notify }: { store: Pick<HealthStore, "get" | "put">; notify: HealthNotifier }): HealthSink {
  return {
    async record(project, id, result, now) {
      const previous = store.get(project)[id];
      const current = store.put(project, id, result, now);
      await notify(project, id, previous, current, now);
    },
  };
}

export type TokenHealthJobDeps = {
  project: string;
  integrations: () => readonly IntegrationId[];
  test: (id: IntegrationId, now: Date) => Promise<ConnectionTestResult>;
};

export const createTokenHealthJob = ({ project, integrations, test }: TokenHealthJobDeps): Job => ({
  name: TOKEN_HEALTH_JOB,
  project,
  due: (now) => (now.getUTCHours() >= CHECK_HOUR_UTC ? now.toISOString().slice(0, 10) : null),
  async run({ now, log }) {
    for (const id of integrations()) {
      const { ok } = await test(id, now);
      log.info("token health checked", { integration: id, ok });
    }
  },
});

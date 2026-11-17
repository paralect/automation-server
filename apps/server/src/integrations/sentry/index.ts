import { createSentryToGithubIssue } from "@automation-server/automations";
import { createSentrySource } from "@automation-server/sources";
import { parseRepo } from "@automation-server/settings";

import { defineModule } from "../module";

const SENTRY_REJECTED = new Set([401, 403]);

export const sentry = defineModule({
  id: "sentry",
  build({ sentry, github }, { log, fetch }) {
    if (!sentry.configured) return {};
    const source = createSentrySource({
      clientSecret: sentry.values.clientSecret,
      apiBaseUrl: sentry.values.apiBaseUrl,
      authToken: sentry.values.authToken || undefined,
      fetch,
    });

    if (!github.configured || !github.values.repo) {
      log.warn("sentry alerts will be ignored until GitHub token and issues repository are set");
      return { sources: [source] };
    }
    return {
      sources: [source],
      automations: [
        createSentryToGithubIssue({
          repo: parseRepo(github.values.repo),
          token: github.values.token,
          levels: sentry.values.levels,
          environments: sentry.values.environments ?? [],
          minEventCount: sentry.values.minEventCount,
          fetch,
        }),
      ],
    };
  },
  async test({ sentry }, { fetch: doFetch = fetch }) {
    if (!sentry.configured) return { ok: false, available: true, message: "Sentry is not configured" };
    const { authToken, apiBaseUrl } = sentry.values;
    if (!authToken) return { ok: true, available: true, message: "No auth token configured, enrichment is off" };
    const res = await doFetch(`${apiBaseUrl.replace(/\/+$/, "")}/api/0/`, { headers: { Authorization: `Bearer ${authToken}` }, redirect: "error" });
    if (SENTRY_REJECTED.has(res.status)) return { ok: false, available: true, message: `Sentry rejected the auth token (${res.status})` };
    if (!res.ok) return { ok: false, available: true, message: `Sentry answered ${res.status} for GET /api/0/` };
    return { ok: true, available: true, message: "Sentry accepted the auth token", details: { apiBaseUrl } };
  },
});

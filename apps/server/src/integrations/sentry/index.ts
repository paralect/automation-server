import { createSentryToGithubIssue } from "@automation-server/automations";
import { createSentrySource } from "@automation-server/sources";
import { parseRepo } from "@automation-server/settings";

import { defineModule } from "../module";

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
});

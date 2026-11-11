import { github } from "./github";
import type { IntegrationModule } from "./module";
import { posthog } from "./posthog";
import { sentry } from "./sentry";

/** One line per integration. A new integration adds a folder and an entry here. */
export const INTEGRATION_MODULES: readonly IntegrationModule[] = [github, sentry, posthog];

import { crisp } from "./crisp";
import { github } from "./github";
import { linear } from "./linear";
import type { IntegrationModule } from "./module";
import { openrouter } from "./openrouter";
import { posthog } from "./posthog";
import { sentry } from "./sentry";

/** One line per integration. A new integration adds a folder and an entry here. */
export const INTEGRATION_MODULES: readonly IntegrationModule[] = [github, sentry, linear, posthog, openrouter, crisp];

import { github } from "./github";
import { linear } from "./linear";
import type { IntegrationModule } from "./module";
import { sentry } from "./sentry";

/** One line per integration. A new integration adds a folder and an entry here. */
export const INTEGRATION_MODULES: readonly IntegrationModule[] = [github, sentry, linear];

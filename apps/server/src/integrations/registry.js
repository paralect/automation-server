import { crisp } from "./crisp";
import { github } from "./github";
import { linear } from "./linear";
import { openrouter } from "./openrouter";
import { posthog } from "./posthog";
import { sentry } from "./sentry";
import { slack } from "./slack";
export const INTEGRATION_MODULES = [github, sentry, linear, posthog, openrouter, crisp, slack];

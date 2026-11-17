import { GITHUB_API, githubHeaders } from "@automation-server/api/githubApi";
import { createLinearLabelToPr } from "@automation-server/automations";
import { createLinearSource } from "@automation-server/sources";
import { parseRepo } from "@automation-server/settings";

import { z } from "zod";

import { defineModule } from "../module";

const workflowSchema = z.object({ state: z.string().optional() });

export const linear = defineModule({
  id: "linear",
  build({ linear, github }, { log, fetch }) {
    if (!linear.configured) return {};
    const source = createLinearSource({ webhookSecret: linear.values.webhookSecret });

    if (!github.configured) {
      log.warn("linear webhooks will be ignored until the GitHub token is set");
      return { sources: [source] };
    }
    return {
      sources: [source],
      automations: [
        createLinearLabelToPr({
          triggerLabel: linear.values.triggerLabel,
          repo: parseRepo(linear.values.targetRepo),
          token: github.values.token,
          workflowFile: linear.values.workflowFile,
          ref: linear.values.ref,
          fetch,
        }),
      ],
    };
  },
  async test({ linear, github }, { fetch: doFetch = fetch }) {
    if (!linear.configured) return { ok: false, available: true, message: "Linear is not configured" };
    const details = { webhook: "/webhooks/linear", signature: "webhook secret is set", triggerLabel: linear.values.triggerLabel };
    if (!github.configured) {
      return { ok: false, available: true, message: "The webhook is ready but nothing will run until the GitHub token is set", details };
    }
    const { owner, name } = parseRepo(linear.values.targetRepo);
    const file = linear.values.workflowFile;
    const res = await doFetch(`${GITHUB_API}/repos/${owner}/${name}/actions/workflows/${encodeURIComponent(file)}`, {
      headers: githubHeaders(github.values.token),
    });
    const repo = `${owner}/${name}`;
    if (res.status === 404) {
      return { ok: false, available: true, message: `Workflow ${file} is not installed in ${repo}, or the token cannot see it. Install it from the Workflows page.`, details };
    }
    if (!res.ok) return { ok: false, available: true, message: `GitHub answered ${res.status} for workflow ${file} in ${repo}`, details };
    const state = workflowSchema.safeParse(await res.json().catch(() => null)).data?.state ?? "unknown";
    if (state !== "active") {
      return { ok: false, available: true, message: `Workflow ${file} in ${repo} is ${state}. Enable it in the repository's Actions tab.`, details };
    }
    return { ok: true, available: true, message: `Webhook is ready and ${file} is active in ${repo}`, details };
  },
});

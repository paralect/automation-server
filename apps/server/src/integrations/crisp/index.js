import { createCrispTriage, MODES } from "@automation-server/automations";
import { withDryRun } from "@automation-server/core";
import { createCrispClient, createCrispSource, CrispApiError } from "@automation-server/sources";
import { parseRepo } from "@automation-server/settings";
import { defineModule } from "../module";
const MODE_SET = new Set(MODES);
const isMode = (value) => MODE_SET.has(value);
export const crisp = defineModule({
    id: "crisp",
    build({ crisp, openrouter, github }, { log, fetch }) {
        if (!crisp.configured)
            return {};
        const v = crisp.values;
        const source = createCrispSource({
            websiteId: v.websiteId,
            webhookSecret: v.webhookSecret,
            pluginIdentifier: v.pluginIdentifier,
            pluginKey: v.pluginKey,
            fetch,
        });
        if (!openrouter.configured) {
            log.warn("crisp conversations will not be triaged until the OpenRouter API key is set");
            return { sources: [source] };
        }
        // dry-run previews the strongest mode, so the preview shows every write a fix run would make.
        const dryRun = v.mode === "dry-run";
        const mode = dryRun ? "fix" : isMode(v.mode) ? v.mode : "shadow";
        const target = github.configured && github.values.repo ? { repo: parseRepo(github.values.repo), token: github.values.token } : null;
        if (mode !== "shadow" && !target) {
            log.warn(`crisp triage mode ${v.mode} needs the GitHub token and issues repository, conversations will not be triaged until they are set`);
            return { sources: [source] };
        }
        const triage = createCrispTriage({
            crisp: { websiteId: v.websiteId, identifier: v.pluginIdentifier, key: v.pluginKey },
            openrouter: {
                apiKey: openrouter.values.apiKey,
                triageModel: openrouter.values.triageModel,
                escalationModel: openrouter.values.escalationModel,
            },
            github: target,
            triggerSegment: v.triggerSegment,
            autoTriage: v.autoTriage,
            mode,
            minConfidence: v.minConfidence,
            areas: v.areas ?? [],
            autofixAreas: v.autofixAreas ?? [],
            workflowFile: v.workflowFile,
            fetch,
        });
        return { sources: [source], automations: [dryRun ? withDryRun(triage) : triage] };
    },
    async test({ crisp, openrouter }, { fetch }) {
        if (!crisp.configured)
            return { ok: false, available: true, message: "Crisp is not configured" };
        const v = crisp.values;
        const client = createCrispClient({ websiteId: v.websiteId, identifier: v.pluginIdentifier, key: v.pluginKey, fetch });
        let name;
        try {
            name = (await client.website()).name;
        }
        catch (err) {
            if (err instanceof CrispApiError && (err.status === 401 || err.status === 403)) {
                return { ok: false, available: true, message: `Crisp rejected the plugin token for website ${v.websiteId} (${err.status}). Check the token and that the plugin is installed on the website.` };
            }
            throw err;
        }
        const details = { website: name ?? v.websiteId, mode: v.mode, triggerSegment: v.triggerSegment };
        if (!openrouter.configured) {
            return { ok: false, available: true, message: "The plugin token works, but nothing is triaged until the OpenRouter API key is set", details };
        }
        return { ok: true, available: true, message: `Plugin token can read website ${name ?? v.websiteId}. Write access for notes and segments is only exercised by the first triage.`, details };
    },
});

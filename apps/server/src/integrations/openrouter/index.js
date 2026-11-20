import { createOpenRouterClient, OpenRouterError } from "@automation-server/automations";
import { parseExpiry } from "@automation-server/settings";
import { defineModule } from "../module";
export const openrouter = defineModule({
    id: "openrouter",
    build: () => ({}),
    async test({ openrouter }, { fetch }) {
        if (!openrouter.configured)
            return { ok: false, available: true, message: "OpenRouter API key is not set" };
        try {
            const key = await createOpenRouterClient({ apiKey: openrouter.values.apiKey, fetch }).key();
            const details = { triageModel: openrouter.values.triageModel, escalationModel: openrouter.values.escalationModel };
            if (key.label)
                details.label = key.label;
            if (key.usage !== null)
                details.usage = String(key.usage);
            if (key.limit !== null)
                details.limit = String(key.limit);
            const expiresAt = parseExpiry(key.expiresAt);
            return { ok: true, available: true, ...(expiresAt ? { expiresAt } : {}), message: `OpenRouter accepted the key${key.label ? ` ${key.label}` : ""}`, details };
        }
        catch (err) {
            if (err instanceof OpenRouterError && err.status === 401)
                return { ok: false, available: true, message: "OpenRouter rejected the API key (401)" };
            throw err;
        }
    },
});

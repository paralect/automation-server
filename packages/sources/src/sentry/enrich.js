import { z } from "zod";
import { isSentryIssueAlert } from "./event";
const TIMEOUT_MS = 3000;
const issueSchema = z.object({
    count: z.union([z.string(), z.number()]),
    firstSeen: z.string(),
    lastSeen: z.string(),
    permalink: z.string().nullish(),
});
function originOf(url) {
    try {
        return new URL(url).origin;
    }
    catch {
        return null;
    }
}
export function createSentryIssueEnricher(options) {
    const doFetch = options.fetch ?? fetch;
    const allowedOrigin = originOf(options.apiBaseUrl);
    return async (event) => {
        if (!options.authToken || allowedOrigin === null || !isSentryIssueAlert(event)) {
            return event;
        }
        const url = event.payload.issueApiUrl;
        // The URL comes from the webhook body, so the token only goes to the configured host.
        if (url === null || originOf(url) !== allowedOrigin)
            return event;
        try {
            const response = await doFetch(url, {
                headers: { Authorization: `Bearer ${options.authToken}` },
                signal: AbortSignal.timeout(TIMEOUT_MS),
                redirect: "error",
            });
            if (!response.ok)
                return event;
            const parsed = issueSchema.safeParse(await response.json());
            if (!parsed.success)
                return event;
            const count = Number(parsed.data.count);
            if (!Number.isFinite(count))
                return event;
            const issue = {
                count,
                firstSeen: parsed.data.firstSeen,
                lastSeen: parsed.data.lastSeen,
                permalink: parsed.data.permalink ?? null,
            };
            return { ...event, payload: { ...event.payload, issue } };
        }
        catch {
            return event;
        }
    };
}

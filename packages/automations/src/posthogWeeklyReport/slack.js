import { scrub } from "./scrub";
export async function postToSlack(webhookUrl, text, { fetch: doFetch = fetch, timeoutMs = 15_000, blocks } = {}) {
    const secrets = [webhookUrl, ...webhookUrl.split("/").filter((part) => part.length >= 8)];
    const fail = (what) => {
        throw new Error(`Slack delivery failed: ${scrub(what, secrets)}`);
    };
    let res;
    try {
        res = await doFetch(webhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(blocks ? { text, blocks } : { text }),
            signal: AbortSignal.timeout(timeoutMs),
        });
    }
    catch (err) {
        return fail(err instanceof Error && err.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : err instanceof Error ? err.message : String(err));
    }
    if (!res.ok)
        fail(`HTTP ${res.status}`);
}

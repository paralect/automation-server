import { scrub } from "./scrub";
const message = (err) => (err instanceof Error ? err.message : String(err));
export function createHogqlClient({ host, projectId, apiKey, fetch: doFetch = fetch, timeoutMs = 30_000 }) {
    const url = `${host.replace(/\/+$/, "")}/api/projects/${encodeURIComponent(projectId)}/query/`;
    const fail = (what) => {
        throw new Error(`PostHog query failed: ${scrub(what, [apiKey])}`);
    };
    return {
        async query(hogql) {
            let res;
            try {
                res = await doFetch(url, {
                    method: "POST",
                    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
                    body: JSON.stringify({ query: { kind: "HogQLQuery", query: hogql } }),
                    signal: AbortSignal.timeout(timeoutMs),
                });
            }
            catch (err) {
                return fail(err instanceof Error && err.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : message(err));
            }
            if (!res.ok) {
                const body = await res.text().catch(() => "");
                const hint = res.status === 401 || res.status === 403 ? " (check the personal API key and its query read scope)" : "";
                return fail(`HTTP ${res.status}${hint} ${body}`);
            }
            const json = (await res.json().catch(() => undefined));
            if (!json || !Array.isArray(json.results))
                return fail("response has no results array");
            return json.results;
        },
    };
}

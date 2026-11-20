import { z } from "zod";
import { scrub } from "../../posthogWeeklyReport/scrub";
import { defineTool, ok } from "./types";
const TIMEOUT_MS = 10_000;
const organizations = z.array(z.object({ slug: z.string() }));
const issues = z.array(z.object({
    shortId: z.string(),
    title: z.string(),
    level: z.string().nullish(),
    status: z.string().nullish(),
    count: z.union([z.string(), z.number()]),
    userCount: z.number().nullish(),
    firstSeen: z.string(),
    lastSeen: z.string(),
    culprit: z.string().nullish(),
    permalink: z.string().nullish(),
}));
export function sentryTools({ authToken, apiBaseUrl, fetch: doFetch = fetch }) {
    const base = apiBaseUrl.replace(/\/+$/, "");
    const get = async (path, shape) => {
        let res;
        try {
            res = await doFetch(`${base}${path}`, {
                headers: { Authorization: `Bearer ${authToken}` },
                signal: AbortSignal.timeout(TIMEOUT_MS),
                redirect: "error",
            });
        }
        catch {
            throw new Error("Sentry request failed: network error");
        }
        if (!res.ok)
            throw new Error(`Sentry request failed: ${scrub(`HTTP ${res.status}`, [authToken])}`);
        const parsed = shape.safeParse(await res.json().catch(() => null));
        if (!parsed.success)
            throw new Error("Sentry request failed: unexpected response");
        return parsed.data;
    };
    return [
        defineTool({
            name: "sentry.listIssues",
            kind: "read",
            description: "List Sentry issues, newest activity first. The query uses Sentry search syntax, for example `is:unresolved level:error` or free text.",
            argsSchema: z.object({
                query: z.string().max(200).default("is:unresolved"),
                limit: z.number().int().min(1).max(10).default(5),
            }),
            async run({ query, limit }) {
                const [org] = await get("/api/0/organizations/", organizations);
                if (!org)
                    throw new Error("the Sentry token has no organization");
                const params = new URLSearchParams({ query, limit: String(limit), sort: "date", statsPeriod: "14d" });
                const found = await get(`/api/0/organizations/${encodeURIComponent(org.slug)}/issues/?${params}`, issues);
                return ok(found.map((i) => ({ ...i, count: Number(i.count) })));
            },
        }),
    ];
}

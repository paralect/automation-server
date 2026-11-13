import { DAILY_USERS_QUERY, TOP_EVENTS_QUERY, TOP_PAGES_QUERY, TOTALS_QUERY, type PosthogReportConfig } from "../../src/posthogWeeklyReport";

export const API_KEY = "phx_SecretPersonalKey1234567890";
export const SLACK_URL = "https://hooks.slack.com/services/T0SECRET/B0SECRET/xoxSecretWebhookPath99";

export const CONFIG: PosthogReportConfig = {
  host: "https://eu.posthog.com/",
  projectId: "4242",
  personalApiKey: API_KEY,
  slackWebhookUrl: SLACK_URL,
  reportTitle: "Acme <weekly> report",
  dayOfWeek: 1,
  hourUtc: 9,
};

export const RESULTS: Record<string, unknown[][]> = {
  [TOTALS_QUERY]: [[1200, 1000, 5000, 5000, 1500, 2000]],
  [TOP_PAGES_QUERY]: [
    ["/", 3000, 2500],
    ["/pricing", 800, 0],
    [null, 10, 10],
  ],
  [TOP_EVENTS_QUERY]: [
    ["$pageview", 5000, 5000],
    ["signed_up", 42, 40],
  ],
  // Day 2 has no events, so the query returns no row for it.
  [DAILY_USERS_QUERY]: [
    [0, 300],
    [1, 250],
    [3, 200],
    [7, 120],
    [13, 90],
  ],
};

type Call = { url: string; headers: Record<string, string>; body: unknown };

export function fakeFetch(handler: (call: Call) => Response | Promise<Response> = defaultHandler) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fn, calls, slackPosts: () => calls.filter((c) => c.url === SLACK_URL) };
}

export function defaultHandler(call: Call): Response {
  if (call.url === SLACK_URL) return new Response("ok");
  const query = (call.body as { query?: { query?: string } }).query?.query ?? "";
  const results = RESULTS[query];
  return results ? Response.json({ results }) : new Response("unknown query", { status: 400 });
}

import { describe, expect, test } from "bun:test";

import { buildReport, formatDelta, generateReport } from "../../src/posthogWeeklyReport";
import { API_KEY, CONFIG, fakeFetch } from "./fakes";

const NOW = new Date("2026-02-16T09:00:00Z");

describe("posthog report", () => {
  test("formats a week-over-week Slack report from PostHog results", async () => {
    const posthog = fakeFetch();
    const text = await generateReport(CONFIG, NOW, { fetch: posthog.fn });

    expect(text).toBe(
      [
        "*Acme &lt;weekly&gt; report*",
        "2026-02-09 to 2026-02-16 compared with 2026-02-02 to 2026-02-09 (UTC)",
        "",
        "Unique users: *1,200* (+20.0%, was 1,000)",
        "Pageviews: *5,000* (no change, was 5,000)",
        "Sessions: *1,500* (-25.0%, was 2,000)",
        "",
        "*Top pages*",
        "1. /: 3,000 (+20.0%)",
        "2. /pricing: 800 (new)",
        "3. (none): 10 (no change)",
        "",
        "*Top events*",
        "1. $pageview: 5,000 (no change)",
        "2. signed_up: 42 (+5.0%)",
      ].join("\n"),
    );
    expect(posthog.calls).toHaveLength(3);
    for (const call of posthog.calls) {
      expect(call.url).toBe("https://eu.posthog.com/api/projects/4242/query/");
      expect(call.headers.authorization).toBe(`Bearer ${API_KEY}`);
      expect(call.body).toMatchObject({ query: { kind: "HogQLQuery" } });
    }
  });

  test("an empty project says so instead of printing zeros", () => {
    const zero = { current: 0, previous: 0 };
    const text = buildReport({ users: zero, pageviews: zero, sessions: zero, pages: [], events: [] }, NOW, "Weekly");
    expect(text).toEndWith("No events were recorded in the last 14 days.");
  });

  test("deltas", () => {
    expect(formatDelta({ current: 0, previous: 0 })).toBe("no change");
    expect(formatDelta({ current: 5, previous: 0 })).toBe("new");
    expect(formatDelta({ current: 0, previous: 5 })).toBe("-100.0%");
    expect(formatDelta({ current: 1001, previous: 1000 })).toBe("+0.1%");
  });
});

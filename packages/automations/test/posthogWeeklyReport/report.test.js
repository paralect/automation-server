import { describe, expect, test } from "bun:test";
import { buildReport, buildReportSpec, formatDelta, generateReport, reportBlocks } from "../../src/posthogWeeklyReport";
import { API_KEY, CONFIG, fakeFetch } from "./fakes";
const NOW = new Date("2026-02-16T09:00:00Z");
describe("posthog report", () => {
    test("formats a week-over-week Slack report from PostHog results", async () => {
        const posthog = fakeFetch();
        const { text } = await generateReport(CONFIG, NOW, { fetch: posthog.fn });
        expect(text).toBe([
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
        ].join("\n"));
        expect(posthog.calls).toHaveLength(4);
        for (const call of posthog.calls) {
            expect(call.url).toBe("https://eu.posthog.com/api/projects/4242/query/");
            expect(call.headers.authorization).toBe(`Bearer ${API_KEY}`);
            expect(call.body).toMatchObject({ query: { kind: "HogQLQuery" } });
        }
    });
    test("an empty project says so instead of printing zeros", () => {
        const zero = { current: 0, previous: 0 };
        const text = buildReport({ users: zero, pageviews: zero, sessions: zero, pages: [], events: [], dailyUsers: [] }, NOW, "Weekly");
        expect(text).toEndWith("No events were recorded in the last 14 days.");
    });
    test("renders the report as Slack Block Kit with native charts and a table", async () => {
        const { blocks } = await generateReport(CONFIG, NOW, { fetch: fakeFetch().fn });
        expect(blocks.map((b) => b.type)).toEqual(["header", "context", "section", "data_visualization", "divider", "data_table", "data_visualization"]);
        expect(blocks[0]).toMatchObject({ text: { type: "plain_text", text: "Acme <weekly> report" } });
        expect(blocks[2]).toMatchObject({ fields: [{ text: "*Unique users*\n1,200  (+20.0%, was 1,000)" }, {}, {}] });
        const daily = blocks[3];
        expect(daily.title).toBe("Unique users per day");
        expect(daily.chart.type).toBe("line");
        expect(daily.chart.axis_config.categories).toEqual(["Feb 10", "Feb 11", "Feb 12", "Feb 13", "Feb 14", "Feb 15", "Feb 16"]);
        expect(daily.chart.series.map((s) => [s.name, s.data.map((d) => d.value)])).toEqual([
            ["This week", [0, 0, 0, 200, 0, 250, 300]],
            ["Previous week", [90, 0, 0, 0, 0, 0, 120]],
        ]);
        expect(blocks[5]).toMatchObject({ caption: "Top pages" });
        expect(blocks[6]).toMatchObject({ title: "Top events", chart: { type: "bar", axis_config: { categories: ["$pageview", "signed_up"] } } });
    });
    test("an empty project renders one line instead of empty charts", () => {
        const zero = { current: 0, previous: 0 };
        const spec = buildReportSpec({ users: zero, pageviews: zero, sessions: zero, pages: [], events: [], dailyUsers: [] }, NOW, "Weekly");
        const blocks = reportBlocks(spec);
        expect(blocks.map((b) => b.type)).toEqual(["header", "context", "section"]);
        expect(JSON.stringify(blocks[2])).toContain("No events were recorded in the last 14 days.");
    });
    test("long and colliding event names still give Slack distinct chart labels", () => {
        const zero = { current: 0, previous: 0 };
        const one = { current: 1, previous: 1 };
        const events = [
            { name: "checkout_completed_with_coupon", ...one },
            { name: "checkout_completed_without_coupon", ...one },
        ];
        const spec = buildReportSpec({ users: one, pageviews: zero, sessions: zero, pages: [], events, dailyUsers: [] }, NOW, "Weekly");
        const chart = reportBlocks(spec).find((b) => b.title === "Top events");
        expect(chart.chart.axis_config.categories).toEqual(["checkout_completed_…", "2. checkout_complet…"]);
    });
    test("deltas", () => {
        expect(formatDelta({ current: 0, previous: 0 })).toBe("no change");
        expect(formatDelta({ current: 5, previous: 0 })).toBe("new");
        expect(formatDelta({ current: 0, previous: 5 })).toBe("-100.0%");
        expect(formatDelta({ current: 1001, previous: 1000 })).toBe("+0.1%");
    });
});

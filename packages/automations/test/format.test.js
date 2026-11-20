import { describe, expect, test } from "bun:test";
import { formatIssue } from "../src/sentryToGithubIssue/format";
import { alert, frame } from "./fixtures";
describe("formatIssue snapshot", () => {
    test("small alert", () => {
        const out = formatIssue(alert());
        expect(out.title).toBe("[Sentry] TypeError: x is undefined");
        expect(out.labels).toEqual(["sentry", "level:error", "env:production"]);
        expect(out.body).toBe([
            "https://acme.sentry.io/issues/4501/",
            "Sentry Issue: 4501",
            "",
            "- Level: error",
            "- Environment: production",
            "- Release: web@1.2.3",
            "- First seen: 2026-01-01T00:00:00Z",
            "- Last seen: 2026-01-02T00:00:00Z",
            "- Event count: 12",
            "- Culprit: src/app.ts in handler",
            "",
            "## Stack trace",
            "",
            "```",
            "TypeError: x is undefined",
            "  at handler (src/app.ts:10:5)",
            "      return x.y;",
            "  at dispatch (node_modules/lib/index.js:1:2)",
            "```",
            "",
            "## Breadcrumbs",
            "",
            "[2026-01-01T00:00:00Z] fetch/http info (GET https://api.example.com/users -> 500)",
        ].join("\n"));
    });
    test("unknown stats, no env, link derived from event url", () => {
        const out = formatIssue(alert({ issue: null, environment: null, release: null, culprit: null }));
        expect(out.labels).toEqual(["sentry", "level:error"]);
        const lines = out.body.split("\n");
        expect(lines[0]).toBe("https://acme.sentry.io/issues/4501/");
        expect(lines[1]).toBe("Sentry Issue: 4501");
        expect(out.body).toContain("- First seen: unknown\n- Last seen: unknown\n- Event count: unknown\n- Culprit: unknown");
        expect(out.body).toContain("- Environment: unknown");
    });
    test("link falls back to issueApiUrl", () => {
        const out = formatIssue(alert({ issue: null, eventWebUrl: null }));
        expect(out.body.split("\n")[0]).toBe("https://sentry.io/api/0/organizations/acme/issues/4501/");
    });
    test("no exceptions, no breadcrumbs", () => {
        const out = formatIssue(alert({ exceptions: [], breadcrumbs: [] }));
        expect(out.body).toContain("No exception data available.");
        expect(out.body).toContain("No breadcrumbs recorded.");
    });
});
describe("caps", () => {
    test("title truncated to 120", () => {
        const out = formatIssue(alert({ title: "oops ".repeat(60) }));
        expect(out.title.length).toBe(120);
        expect(out.title.startsWith("[Sentry] oops oops")).toBe(true);
    });
    test("most recent call first, in-app before non-in-app, non-in-app capped", () => {
        const frames = [
            ...Array.from({ length: 5 }, (_, i) => frame({ function: `lib${i}`, inApp: false, filename: "l.js" })),
            frame({ function: "appOuter" }),
            frame({ function: "appInner" }),
        ];
        const out = formatIssue(alert({ exceptions: [{ type: "E", value: "v", frames }] }), { maxNonInAppFrames: 2 });
        const calls = [...out.body.matchAll(/ {2}at (\w+) /g)].map((m) => m[1]);
        expect(calls).toEqual(["appInner", "appOuter", "lib4", "lib3"]);
        expect(out.body).toContain("... 3 more frames omitted");
    });
    test("frame count capped at 40", () => {
        const frames = Array.from({ length: 100 }, (_, i) => frame({ function: `f${i}`, lineno: i }));
        const out = formatIssue(alert({ exceptions: [{ type: "E", value: "v", frames }] }));
        expect(out.body.match(/^ {2}at /gm)?.length).toBe(40);
        expect(out.body).toContain("... 60 more frames omitted");
    });
    test("stack block capped at 6000 chars with note", () => {
        const frames = Array.from({ length: 40 }, (_, i) => frame({ function: `f${i}`, contextLine: "y".repeat(190) }));
        const out = formatIssue(alert({ exceptions: [{ type: "E", value: "v", frames }] }));
        const block = /```\n([\s\S]*?)\n```/.exec(out.body)?.[1] ?? "";
        expect(block.length).toBeLessThanOrEqual(6000);
        expect(block).toMatch(/\.\.\. \d+ more frames? omitted$/);
    });
    test("context line capped at 200", () => {
        const out = formatIssue(alert({ exceptions: [{ type: "E", value: "v", frames: [frame({ contextLine: "z".repeat(500) })] }] }));
        const ctx = out.body.split("\n").find((l) => l.startsWith("      z")) ?? "";
        expect(ctx.trim().length).toBe(200);
    });
    test("multiple exceptions: last first, each with header", () => {
        const out = formatIssue(alert({
            exceptions: [
                { type: "Cause", value: "root", frames: [frame({ function: "causeFn" })] },
                { type: "Outer", value: "wrapped", frames: [frame({ function: "outerFn" })] },
            ],
        }));
        expect(out.body.indexOf("Outer: wrapped")).toBeLessThan(out.body.indexOf("outerFn"));
        expect(out.body.indexOf("outerFn")).toBeLessThan(out.body.indexOf("Cause: root"));
        expect(out.body).toContain("causeFn");
    });
    test("only last 10 breadcrumbs", () => {
        const crumbs = Array.from({ length: 15 }, (_, i) => ({
            timestamp: `t${i}`, type: "default", category: "c", level: "info", message: `m${i}`, url: null, method: null, statusCode: null,
        }));
        const out = formatIssue(alert({ breadcrumbs: crumbs }));
        expect(out.body).not.toContain("[t4]");
        expect(out.body).toContain("[t5] c/default info: m5");
        expect(out.body).toContain("[t14]");
    });
    test("body hard cap", () => {
        const out = formatIssue(alert({ culprit: "c".repeat(5000) }), { maxBodyChars: 300 });
        expect(out.body.length).toBeLessThanOrEqual(300);
        expect(out.body.endsWith("... body truncated")).toBe(true);
    });
    test("stack content cannot break the fence", () => {
        const out = formatIssue(alert({ exceptions: [{ type: "E", value: "``` boom", frames: [] }] }));
        expect(out.body.match(/```/g)?.length).toBe(2);
    });
});
describe("redaction", () => {
    test("planted secrets never appear", () => {
        const secrets = ["leak@evil.com", "10.20.30.40", "Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MEFiQ2RFZg", "hunter2", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sigsigsig"];
        const out = formatIssue(alert({
            title: "fail for leak@evil.com",
            culprit: "handler 10.20.30.40",
            environment: "prod",
            exceptions: [
                {
                    type: "Error",
                    value: "token=Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MEFiQ2RFZg for leak@evil.com",
                    frames: [
                        frame({
                            filename: "https://x.com/a.js?auth=hunter2",
                            function: "fn",
                            contextLine: "send('leak@evil.com', password=hunter2, 10.20.30.40)",
                        }),
                    ],
                },
            ],
            breadcrumbs: [
                { timestamp: "t", type: "x", category: "ui", level: "info", message: `jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sigsigsig from 10.20.30.40`, url: "https://a.com/p?secret=hunter2", method: "POST", statusCode: 200 },
            ],
        }));
        for (const s of secrets) {
            expect(out.title).not.toContain(s);
            expect(out.body).not.toContain(s);
        }
        expect(out.body).not.toContain("secret=");
    });
});

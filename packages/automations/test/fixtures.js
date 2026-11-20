export const frame = (over = {}) => ({
    filename: "src/app.ts",
    module: null,
    function: "handler",
    lineno: 10,
    colno: 5,
    inApp: true,
    contextLine: null,
    ...over,
});
export const alert = (over = {}) => ({
    issueId: "4501",
    issueApiUrl: "https://sentry.io/api/0/organizations/acme/issues/4501/",
    eventId: "abc",
    eventWebUrl: "https://acme.sentry.io/issues/4501/events/abc123/?project=1",
    title: "TypeError: x is undefined",
    level: "error",
    culprit: "src/app.ts in handler",
    environment: "production",
    release: "web@1.2.3",
    platform: "javascript",
    ruleName: null,
    occurredAt: "2026-01-01T00:00:00Z",
    exceptions: [
        {
            type: "TypeError",
            value: "x is undefined",
            frames: [
                frame({ filename: "node_modules/lib/index.js", function: "dispatch", lineno: 1, colno: 2, inApp: false }),
                frame({ filename: "src/app.ts", function: "handler", lineno: 10, colno: 5, contextLine: "  return x.y;" }),
            ],
        },
    ],
    breadcrumbs: [
        {
            timestamp: "2026-01-01T00:00:00Z",
            type: "http",
            category: "fetch",
            level: "info",
            message: null,
            url: "https://api.example.com/users?token=abc",
            method: "GET",
            statusCode: 500,
        },
    ],
    issue: {
        count: 12,
        firstSeen: "2026-01-01T00:00:00Z",
        lastSeen: "2026-01-02T00:00:00Z",
        permalink: "https://acme.sentry.io/issues/4501/",
    },
    ...over,
});
export const sentryEvent = (payload) => ({
    source: "sentry",
    kind: "issue_alert",
    externalId: "e1",
    receivedAt: "2026-01-01T00:00:00Z",
    payload,
});

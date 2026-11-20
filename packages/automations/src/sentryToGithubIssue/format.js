import { redactText, redactUrl, singleLine, truncate } from "../redact";
const TITLE_MAX = 120;
const CONTEXT_MAX = 200;
const HEADER_MAX = 500;
const BREADCRUMB_MAX = 300;
const NOTE_RESERVE = 80;
const clean = (s, max) => truncate(singleLine(redactText(s ?? "")), max);
const orUnknown = (s, max = 300) => (s ? clean(s, max) || "unknown" : "unknown");
const labelPart = (s) => s.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").slice(0, 40);
export const sentryMarker = (issueId) => `Sentry Issue: ${singleLine(issueId)}`;
export function sentryIssueLink(alert) {
    if (alert.issue?.permalink)
        return redactUrl(alert.issue.permalink);
    if (alert.eventWebUrl) {
        const base = redactUrl(alert.eventWebUrl);
        return base.replace(/\/events\/[^/]+\/?$/, "/");
    }
    if (alert.issueApiUrl)
        return redactUrl(alert.issueApiUrl);
    return "Sentry issue link unavailable";
}
function frameLines(frame) {
    const fn = frame.function ? clean(frame.function, 200) : "<anonymous>";
    let loc = redactUrl(frame.filename ?? frame.module ?? "<unknown>");
    if (frame.lineno !== null)
        loc += `:${frame.lineno}`;
    if (frame.lineno !== null && frame.colno !== null)
        loc += `:${frame.colno}`;
    const lines = [`  at ${fn} (${loc})`];
    const ctx = frame.contextLine ? truncate(redactText(frame.contextLine).trim(), CONTEXT_MAX) : "";
    if (ctx)
        lines.push(`      ${singleLine(ctx)}`);
    return lines;
}
function orderedFrames(ex, maxNonInApp) {
    const recent = [...ex.frames].reverse();
    const inApp = recent.filter((f) => f.inApp);
    const rest = recent.filter((f) => !f.inApp).slice(0, maxNonInApp);
    return [...inApp, ...rest];
}
function stackBlock(alert, opts) {
    const lines = [];
    let chars = 0;
    let printed = 0;
    const push = (l) => {
        lines.push(l);
        chars += l.length + 1;
    };
    const exceptions = [...alert.exceptions].reverse();
    const total = exceptions.reduce((n, e) => n + e.frames.length, 0);
    const budget = opts.maxStackChars - NOTE_RESERVE;
    let full = false;
    for (const ex of exceptions) {
        push(clean(`${ex.type ?? "Error"}: ${ex.value ?? ""}`, HEADER_MAX).replace(/: $/, ""));
        if (full)
            continue;
        for (const frame of orderedFrames(ex, opts.maxNonInAppFrames)) {
            const entry = frameLines(frame);
            const size = entry.reduce((n, l) => n + l.length + 1, 0);
            if (printed >= opts.maxFrames || chars + size > budget) {
                full = true;
                break;
            }
            entry.forEach(push);
            printed++;
        }
    }
    if (exceptions.length === 0)
        push("No exception data available.");
    if (printed < total)
        push(`... ${total - printed} more frame${total - printed === 1 ? "" : "s"} omitted`);
    return lines.join("\n").replaceAll("```", "'''");
}
function breadcrumbLine(b) {
    const kind = [b.category, b.type].filter(Boolean).join("/") || "event";
    let line = `[${b.timestamp ?? "unknown time"}] ${kind}${b.level ? ` ${b.level}` : ""}`;
    if (b.message)
        line += `: ${singleLine(b.message)}`;
    if (b.url || b.method) {
        const req = [b.method, b.url ? redactUrl(b.url) : null].filter(Boolean).join(" ");
        line += ` (${req}${b.statusCode !== null ? ` -> ${b.statusCode}` : ""})`;
    }
    return truncate(singleLine(redactText(line)), BREADCRUMB_MAX);
}
export function formatIssue(alert, options = {}) {
    const opts = {
        maxNonInAppFrames: 10,
        maxFrames: 40,
        maxStackChars: 6000,
        maxBodyChars: 60000,
        maxBreadcrumbs: 10,
        ...options,
    };
    const title = truncate(`[Sentry] ${singleLine(redactText(alert.title))}`, TITLE_MAX);
    const labels = ["sentry", `level:${labelPart(alert.level) || "unknown"}`];
    const env = alert.environment ? labelPart(alert.environment) : "";
    if (env)
        labels.push(`env:${env}`);
    const stats = alert.issue;
    const breadcrumbs = alert.breadcrumbs.slice(-opts.maxBreadcrumbs).map(breadcrumbLine);
    const body = [
        sentryIssueLink(alert),
        sentryMarker(alert.issueId),
        "",
        `- Level: ${orUnknown(alert.level)}`,
        `- Environment: ${orUnknown(alert.environment)}`,
        `- Release: ${orUnknown(alert.release)}`,
        `- First seen: ${stats ? orUnknown(stats.firstSeen) : "unknown"}`,
        `- Last seen: ${stats ? orUnknown(stats.lastSeen) : "unknown"}`,
        `- Event count: ${stats ? stats.count : "unknown"}`,
        `- Culprit: ${orUnknown(alert.culprit)}`,
        "",
        "## Stack trace",
        "",
        "```",
        stackBlock(alert, opts),
        "```",
        "",
        "## Breadcrumbs",
        "",
        breadcrumbs.length > 0 ? breadcrumbs.join("\n") : "No breadcrumbs recorded.",
    ].join("\n");
    return { title, body: capBody(body, opts.maxBodyChars), labels };
}
function capBody(body, max) {
    if (body.length <= max)
        return body;
    const note = "\n\n... body truncated";
    return body.slice(0, max - note.length) + note;
}

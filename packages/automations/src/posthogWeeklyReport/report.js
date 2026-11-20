const DAY = 86_400_000;
const number = new Intl.NumberFormat("en-US");
export const formatCount = (n) => number.format(n);
export function formatDelta({ current, previous }) {
    if (previous === 0)
        return current === 0 ? "no change" : "new";
    const pct = ((current - previous) / previous) * 100;
    const rounded = Math.round(pct * 10) / 10;
    if (rounded === 0)
        return "no change";
    return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}%`;
}
const escapeSlack = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const day = (d) => d.toISOString().slice(0, 10);
const totalLine = (label, pair) => `${label}: *${formatCount(pair.current)}* (${formatDelta(pair)}, was ${formatCount(pair.previous)})`;
const rankedLines = (rows) => rows.length === 0
    ? ["No data"]
    : rows.map((r, i) => `${i + 1}. ${escapeSlack(r.name)}: ${formatCount(r.current)} (${formatDelta(r)})`);
export function buildReport(data, now, title) {
    const from = new Date(now.getTime() - 7 * DAY);
    const prevFrom = new Date(now.getTime() - 14 * DAY);
    const empty = [data.users, data.pageviews, data.sessions].every((p) => p.current === 0 && p.previous === 0);
    const head = `*${escapeSlack(title)}*\n${day(from)} to ${day(now)} compared with ${day(prevFrom)} to ${day(from)} (UTC)`;
    if (empty)
        return `${head}\n\nNo events were recorded in the last 14 days.`;
    return [
        head,
        "",
        totalLine("Unique users", data.users),
        totalLine("Pageviews", data.pageviews),
        totalLine("Sessions", data.sessions),
        "",
        "*Top pages*",
        ...rankedLines(data.pages),
        "",
        "*Top events*",
        ...rankedLines(data.events),
    ].join("\n");
}

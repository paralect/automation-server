export type Pair = { readonly current: number; readonly previous: number };
export type Ranked = Pair & { readonly name: string };

export type ReportData = {
  readonly users: Pair;
  readonly pageviews: Pair;
  readonly sessions: Pair;
  readonly pages: readonly Ranked[];
  readonly events: readonly Ranked[];
  /** Unique users per day, index 0 is the last 24 hours, 14 entries. */
  readonly dailyUsers: readonly number[];
};

const DAY = 86_400_000;
const number = new Intl.NumberFormat("en-US");

export const formatCount = (n: number) => number.format(n);

export function formatDelta({ current, previous }: Pair): string {
  if (previous === 0) return current === 0 ? "no change" : "new";
  const pct = ((current - previous) / previous) * 100;
  const rounded = Math.round(pct * 10) / 10;
  if (rounded === 0) return "no change";
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}%`;
}

const escapeSlack = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const day = (d: Date) => d.toISOString().slice(0, 10);

const totalLine = (label: string, pair: Pair) =>
  `${label}: *${formatCount(pair.current)}* (${formatDelta(pair)}, was ${formatCount(pair.previous)})`;

const rankedLines = (rows: readonly Ranked[]) =>
  rows.length === 0
    ? ["No data"]
    : rows.map((r, i) => `${i + 1}. ${escapeSlack(r.name)}: ${formatCount(r.current)} (${formatDelta(r)})`);

/** Slack mrkdwn. The last 7 days end at `now`, compared with the 7 days before. */
export function buildReport(data: ReportData, now: Date, title: string): string {
  const from = new Date(now.getTime() - 7 * DAY);
  const prevFrom = new Date(now.getTime() - 14 * DAY);
  const empty = [data.users, data.pageviews, data.sessions].every((p) => p.current === 0 && p.previous === 0);
  const head = `*${escapeSlack(title)}*\n${day(from)} to ${day(now)} compared with ${day(prevFrom)} to ${day(from)} (UTC)`;
  if (empty) return `${head}\n\nNo events were recorded in the last 14 days.`;
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

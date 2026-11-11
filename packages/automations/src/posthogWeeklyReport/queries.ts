import type { HogqlClient } from "./client";
import type { Ranked, ReportData } from "./report";

const TOP = 10;
const CURRENT = "timestamp >= now() - INTERVAL 7 DAY";
const PREVIOUS = "timestamp < now() - INTERVAL 7 DAY";
const WINDOW = "timestamp >= now() - INTERVAL 14 DAY";

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const ranked = (rows: unknown[][]): Ranked[] =>
  rows.map((row) => ({ name: row[0] === null || row[0] === "" ? "(none)" : String(row[0]), current: num(row[1]), previous: num(row[2]) }));

export const TOTALS_QUERY = `SELECT
  uniqIf(person_id, ${CURRENT}), uniqIf(person_id, ${PREVIOUS}),
  countIf(event = '$pageview' AND ${CURRENT}), countIf(event = '$pageview' AND ${PREVIOUS}),
  uniqIf(properties.$session_id, ${CURRENT}), uniqIf(properties.$session_id, ${PREVIOUS})
  FROM events WHERE ${WINDOW}`;

export const TOP_PAGES_QUERY = `SELECT properties.$pathname AS name, countIf(${CURRENT}) AS c, countIf(${PREVIOUS}) AS p
  FROM events WHERE event = '$pageview' AND ${WINDOW}
  GROUP BY name HAVING c > 0 ORDER BY c DESC, name ASC LIMIT ${TOP}`;

export const TOP_EVENTS_QUERY = `SELECT event AS name, countIf(${CURRENT}) AS c, countIf(${PREVIOUS}) AS p
  FROM events WHERE ${WINDOW}
  GROUP BY name HAVING c > 0 ORDER BY c DESC, name ASC LIMIT ${TOP}`;

/** The last 7 days against the 7 days before them, both relative to PostHog's clock at query time. */
export async function fetchReportData(client: HogqlClient): Promise<ReportData> {
  const [totals, pages, events] = await Promise.all([
    client.query(TOTALS_QUERY),
    client.query(TOP_PAGES_QUERY),
    client.query(TOP_EVENTS_QUERY),
  ]);
  const row = totals[0] ?? [];
  return {
    users: { current: num(row[0]), previous: num(row[1]) },
    pageviews: { current: num(row[2]), previous: num(row[3]) },
    sessions: { current: num(row[4]), previous: num(row[5]) },
    pages: ranked(pages),
    events: ranked(events),
  };
}

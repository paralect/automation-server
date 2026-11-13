import { cardToSlackBlocks, type SlackBlock, type SlackCardElement } from "@chat-adapter/slack/blocks";
import type { Spec } from "@json-render/core";
import { toCard } from "@json-render/chat";

import { formatCount, formatDelta, type Pair, type Ranked, type ReportData } from "./report";

const DAY = 86_400_000;
const TOP_EVENTS_IN_CHART = 5;
// Slack rejects chart labels over 20 characters.
const CHART_LABEL = 20;
const TABLE_CELL = 60;

const shortDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "2-digit", timeZone: "UTC" });

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

const total = (pair: Pair) => `${formatCount(pair.current)}  (${formatDelta(pair)}, was ${formatCount(pair.previous)})`;

type Element = { type: string; props: Record<string, unknown>; children?: string[] };

/**
 * The report as a json-render spec. It is built from the data, not by a model,
 * so the layout is the same every week.
 */
export function buildReportSpec(data: ReportData, now: Date, title: string): Spec {
  const from = new Date(now.getTime() - 7 * DAY);
  const elements: Record<string, Element> = {};
  const children: string[] = [];
  const add = (id: string, element: Element) => {
    elements[id] = element;
    children.push(id);
  };

  elements.root = {
    type: "Card",
    props: { title, subtitle: `${shortDate.format(from)} – ${shortDate.format(now)} vs the 7 days before (UTC)` },
    children,
  };

  const empty = [data.users, data.pageviews, data.sessions].every((p) => p.current === 0 && p.previous === 0);
  if (empty) {
    add("empty", { type: "Text", props: { content: "No events were recorded in the last 14 days." } });
    return { root: "root", elements } as Spec;
  }

  add("totals", { type: "Fields", props: {}, children: ["users", "pageviews", "sessions"] });
  elements.users = { type: "Field", props: { label: "Unique users", value: total(data.users) } };
  elements.pageviews = { type: "Field", props: { label: "Pageviews", value: total(data.pageviews) } };
  elements.sessions = { type: "Field", props: { label: "Sessions", value: total(data.sessions) } };

  // Oldest day first. Day i of this week lines up with day i of the week before.
  const ago = [6, 5, 4, 3, 2, 1, 0];
  add("daily", {
    type: "Chart",
    props: {
      title: "Unique users per day",
      chart: {
        type: "line",
        categories: ago.map((d) => shortDate.format(new Date(now.getTime() - d * DAY))),
        series: [
          { name: "This week", values: ago.map((d) => data.dailyUsers[d] ?? 0) },
          { name: "Previous week", values: ago.map((d) => data.dailyUsers[d + 7] ?? 0) },
        ],
      },
    },
  });

  add("pagesDivider", { type: "Divider", props: {} });
  add("pages", rankedTable("Top pages", "Page", data.pages));

  const events = data.events.slice(0, TOP_EVENTS_IN_CHART);
  if (events.length > 0) {
    add("events", {
      type: "Chart",
      props: {
        title: "Top events",
        chart: {
          type: "bar",
          categories: uniqueLabels(events.map((e) => e.name)),
          series: [
            { name: "This week", values: events.map((e) => e.current) },
            { name: "Previous week", values: events.map((e) => e.previous) },
          ],
        },
      },
    });
  }

  return { root: "root", elements } as Spec;
}

function rankedTable(caption: string, column: string, rows: readonly Ranked[]): Element {
  if (rows.length === 0) return { type: "Text", props: { content: `*${caption}*\nNo data` } };
  return {
    type: "Table",
    props: {
      caption,
      headers: [column, "This week", "Change"],
      align: ["left", "right", "right"],
      rows: rows.map((r) => [clip(r.name, TABLE_CELL), formatCount(r.current), formatDelta(r)]),
    },
  };
}

/** Clips names to Slack's chart label limit and keeps them distinct, since Slack drops a chart with duplicate categories. */
function uniqueLabels(names: readonly string[]): string[] {
  const seen = new Set<string>();
  return names.map((name, i) => {
    let label = clip(name, CHART_LABEL);
    if (seen.has(label)) label = clip(`${i + 1}. ${name}`, CHART_LABEL);
    seen.add(label);
    return label;
  });
}

/** Block Kit for the spec. A chart Slack cannot draw falls back to a text table inside the message. */
export function reportBlocks(spec: Spec): SlackBlock[] {
  return cardToSlackBlocks(toCard(spec) as SlackCardElement);
}

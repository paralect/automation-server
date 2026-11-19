import { createScheduler, createSqliteActivityStore, createSqliteStore, type LogFields, type Logger } from "@automation-server/core";
import { describe, expect, test } from "bun:test";

import { createPosthogWeeklyReportJob, generateReport, POSTHOG_JOB_NAME, postToSlack } from "../../src/posthogWeeklyReport";
import { API_KEY, CONFIG, defaultHandler, fakeFetch, SLACK_URL } from "./fakes";

const quiet: Logger = { info() {}, warn() {}, error() {} };

function capturing() {
  const lines: string[] = [];
  const push = (message: string, fields?: LogFields) => void lines.push(`${message} ${JSON.stringify(fields ?? {})}`);
  return { log: { info: push, warn: push, error: push } satisfies Logger, lines };
}

function setup(fetch: typeof globalThis.fetch, log: Logger = quiet) {
  const clock = { now: new Date("2026-02-16T08:00:00Z") };
  const store = createSqliteStore({ path: ":memory:" });
  const activity = createSqliteActivityStore({ path: ":memory:" });
  const job = createPosthogWeeklyReportJob(CONFIG, { fetch });
  const scheduler = () => createScheduler({ jobs: () => [job], store, log, activity, now: () => clock.now });
  const at = (iso: string) => (clock.now = new Date(iso));
  return { scheduler, at, activity, job };
}

const secretsIn = (text: string) => [API_KEY, SLACK_URL, "xoxSecretWebhookPath99", "T0SECRET/B0SECRET"].filter((s) => text.includes(s));

describe("posthog weekly report job", () => {
  test("sends once per ISO week, also across a restart, and records a schedule run", async () => {
    const http = fakeFetch();
    const { scheduler, at, activity } = setup(http.fn);

    const first = scheduler();
    await first.tick();
    expect(http.slackPosts()).toHaveLength(0);

    for (const time of ["2026-02-16T09:00:00Z", "2026-02-16T09:01:00Z", "2026-02-19T12:00:00Z"]) {
      at(time);
      await first.tick();
    }
    expect(http.slackPosts()).toHaveLength(1);
    expect(http.slackPosts()[0]?.body).toMatchObject({ text: expect.stringContaining("Unique users: *1,200*") });

    at("2026-02-22T23:00:00Z");
    await scheduler().tick();
    expect(http.slackPosts()).toHaveLength(1);

    at("2026-02-23T09:00:00Z");
    await scheduler().tick();
    expect(http.slackPosts()).toHaveLength(2);

    const runs = activity.queryRuns({ limit: 10 }).items;
    expect(runs.map((r) => r.externalId).sort()).toEqual(["2026-W08", "2026-W09"]);
    expect(runs.every((r) => r.automation === POSTHOG_JOB_NAME && r.source === "schedule" && r.status === "succeeded")).toBe(true);
  });

  test("a manual run uses its own key and does not consume the weekly claim", async () => {
    const http = fakeFetch();
    const { scheduler, at, job } = setup(http.fn);
    at("2026-02-16T09:00:00Z");
    const s = scheduler();
    expect(await s.runNow(job, "manual:1")).toMatchObject({ status: "succeeded" });
    await s.tick();
    expect(http.slackPosts()).toHaveLength(2);
  });

  test("PostHog and Slack failures never expose the API key or the webhook URL", async () => {
    const echo = (call: { url: string; headers: Record<string, string> }) =>
      `denied ${call.url} ${call.headers.authorization ?? ""} key=${API_KEY}`;

    const posthogDown = fakeFetch((call) => (call.url === SLACK_URL ? new Response("ok") : new Response(echo(call), { status: 401 })));
    const slackDown = fakeFetch((call) => (call.url === SLACK_URL ? new Response(echo(call), { status: 404 }) : defaultHandler(call)));
    const unreachable = fakeFetch((call) => {
      if (call.url === SLACK_URL) throw new TypeError(`fetch failed for ${SLACK_URL}`);
      return defaultHandler(call);
    });

    for (const http of [posthogDown, slackDown, unreachable]) {
      const { log, lines } = capturing();
      const { scheduler, at, activity } = setup(http.fn, log);
      at("2026-02-16T09:00:00Z");
      await scheduler().tick();
      const run = activity.queryRuns({ limit: 1 }).items[0];
      expect(run?.status).toBe("failed");
      expect(run?.error).toMatch(/^(PostHog query|Slack delivery) failed/);
      expect(secretsIn(run?.error ?? "")).toEqual([]);
      expect(secretsIn(lines.join("\n"))).toEqual([]);
    }
    expect(posthogDown.slackPosts()).toHaveLength(0);
  });

  test("errors thrown directly carry an actionable hint without the secret", async () => {
    const rejected = fakeFetch((call) => new Response(`bad key ${call.headers.authorization}`, { status: 403 }));
    const error = await generateReport(CONFIG, new Date(), { fetch: rejected.fn }).catch((e: Error) => e.message);
    expect(error).toContain("check the personal API key");
    expect(secretsIn(String(error))).toEqual([]);

    const gone = fakeFetch(() => new Response(`no such hook ${SLACK_URL}`, { status: 404 }));
    const slackError = await postToSlack(SLACK_URL, "hi", { fetch: gone.fn }).catch((e: Error) => e.message);
    expect(slackError).toContain("HTTP 404");
    expect(secretsIn(String(slackError))).toEqual([]);
  });

  test("a failed Slack post reports the status code and never the response body", async () => {
    const broken = fakeFetch(() => new Response("internal detail: upstream saw token abc123", { status: 500 }));
    const message = await postToSlack(SLACK_URL, "hi", { fetch: broken.fn }).catch((e: Error) => e.message);
    expect(message).toBe("Slack delivery failed: HTTP 500");
    expect(String(message)).not.toContain("internal detail");
  });
});

import { describe, expect, test } from "bun:test";

import type { Event } from "@automation-server/core/event";

import { createAutomations } from "../src/registry";
import { createSentryToGithubIssue } from "../src/sentryToGithubIssue/automation";
import { shouldHandle } from "../src/sentryToGithubIssue/config";
import type { SentryToGithubIssueConfig } from "../src/sentryToGithubIssue/config";
import { alert, sentryEvent } from "./fixtures";
import { json, mockFetch } from "./github.test";

const TOKEN = "ghp_SUPERSECRETTOKEN";

const setup = (handler: Parameters<typeof mockFetch>[0], over: Partial<SentryToGithubIssueConfig> = {}) => {
  const m = mockFetch(handler);
  const config: SentryToGithubIssueConfig = {
    repo: { owner: "o", name: "r" },
    token: TOKEN,
    levels: ["error", "fatal"],
    environments: [],
    minEventCount: 1,
    fetch: m.fn,
    ...over,
  };
  const logs: { message: string; fields?: Record<string, unknown> }[] = [];
  const log = {
    info: (message: string, fields?: Record<string, unknown>) => logs.push({ message, fields }),
    warn: () => {},
    error: () => {},
  };
  return { ...m, config, logs, log, automation: createSentryToGithubIssue(config) };
};

const happy = (c: { url: string; method: string }) => {
  if (c.url.includes("/search/issues")) return json(200, { items: [] });
  if (c.url.endsWith("/labels")) return json(201, {});
  return json(201, { number: 9, html_url: "https://github.com/o/r/issues/9" });
};

describe("sentry-to-github-issue automation", () => {
  test("happy path: search, labels, then issue", async () => {
    const t = setup(happy);
    await t.automation.run(sentryEvent(alert()), { log: t.log });
    expect(t.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /search/issues",
      "POST /repos/o/r/labels",
      "POST /repos/o/r/labels",
      "POST /repos/o/r/labels",
      "POST /repos/o/r/issues",
    ]);
    const body = t.calls.at(-1)!.body as { title: string; body: string; labels: string[] };
    expect(body.title).toBe("[Sentry] TypeError: x is undefined");
    expect(body.labels).toEqual(["sentry", "level:error", "env:production"]);
    expect(body.body.split("\n").slice(0, 2)).toEqual(["https://acme.sentry.io/issues/4501/", "Sentry Issue: 4501"]);
    expect(t.logs.at(-1)).toEqual({
      message: "created github issue",
      fields: { issueId: "4501", number: 9, url: "https://github.com/o/r/issues/9" },
    });
  });

  test("existing open issue means no create", async () => {
    const t = setup((c) =>
      c.url.includes("/search/issues")
        ? json(200, { items: [{ html_url: "https://github.com/o/r/issues/3", body: "x\nSentry Issue: 4501" }] })
        : json(500, {}),
    );
    await t.automation.run(sentryEvent(alert()), { log: t.log });
    expect(t.calls).toHaveLength(1);
  });

  test("label already exists is fine", async () => {
    const t = setup((c) =>
      c.url.includes("/search/issues") ? json(200, { items: [] })
        : c.url.endsWith("/labels") ? json(422, { errors: [{ code: "already_exists" }] })
        : json(201, { number: 1, html_url: "u" }),
    );
    await t.automation.run(sentryEvent(alert()), { log: t.log });
    expect(t.calls.at(-1)?.url).toEndWith("/issues");
  });

  test("label 403 throws clearly and does not create", async () => {
    const t = setup((c) =>
      c.url.includes("/search/issues") ? json(200, { items: [] }) : json(403, {}),
    );
    const err = await t.automation.run(sentryEvent(alert()), { log: t.log }).catch((e: Error) => e);
    expect((err as Error).message).toContain("status 403");
    expect((err as Error).message).toContain("/repos/o/r/labels");
    expect((err as Error).message).not.toContain(TOKEN);
    expect(t.calls.some((c) => c.url.endsWith("/issues"))).toBe(false);
  });

  test("create 500 throws so the claim is released", async () => {
    const t = setup((c) =>
      c.url.includes("/search/issues") ? json(200, { items: [] })
        : c.url.endsWith("/labels") ? json(201, {})
        : json(500, {}),
    );
    const err = await t.automation.run(sentryEvent(alert()), { log: t.log }).catch((e: Error) => e);
    expect((err as Error).message).toBe("GitHub API POST /repos/o/r/issues failed with status 500");
  });

  test.each<[string, ReturnType<typeof alert>, Partial<SentryToGithubIssueConfig>]>([
    ["level", alert({ level: "warning" }), {}],
    ["environment", alert({ environment: "staging" }), { environments: ["production"] }],
    ["unknown environment", alert({ environment: null }), { environments: ["production"] }],
    ["min count", alert(), { minEventCount: 50 }],
  ])("filtered by %s makes no GitHub calls", async (_n, a, over) => {
    const t = setup(happy, over);
    await t.automation.run(sentryEvent(a), { log: t.log });
    expect(t.calls).toHaveLength(0);
    expect(t.logs[0]?.message).toBe("skipped");
    expect(t.logs[0]?.fields?.reason).toBeString();
  });

  test("unknown stats do not block on min count", () => {
    const t = setup(happy, { minEventCount: 50 });
    expect(shouldHandle(alert({ issue: null }), t.config)).toEqual({ handle: true });
  });

  test("environments and levels match case-insensitively; empty environments means all", () => {
    const t = setup(happy, { levels: ["ERROR"], environments: ["Production"] });
    expect(shouldHandle(alert(), t.config).handle).toBe(true);
    expect(shouldHandle(alert({ environment: "dev" }), setup(happy).config).handle).toBe(true);
  });

  test("matches only sentry issue_alert events", () => {
    const { automation } = setup(happy);
    expect(automation.name).toBe("sentry-to-github-issue");
    expect(automation.matches(sentryEvent(alert()))).toBe(true);
    const other: Event = { source: "github", kind: "issue_alert", externalId: "1", receivedAt: "t", payload: {} };
    expect(automation.matches(other)).toBe(false);
    expect(automation.matches({ ...other, source: "sentry", kind: "metric_alert" })).toBe(false);
  });

  test("registry lists the automations", () => {
    const { config } = setup(happy);
    expect(createAutomations({ sentryToGithubIssue: config }).map((a) => a.name)).toEqual(["sentry-to-github-issue"]);
  });
});

import { describe, expect, test } from "bun:test";

import type { Logger } from "@automation-server/core/logger";
import type { CrispSessionEvent, CustomerRequest } from "@automation-server/sources/crisp/event";

import { createCrispTriage, type CrispTriageConfig } from "../src/crispTriage/automation";
import { applyMode, route } from "../src/crispTriage/route";
import type { Triage } from "../src/crispTriage/types";
import { json, mockFetch } from "./github.test";

const SESSION = "session_abc";
const EMAIL = "jane.doe@example.com";
const ISSUE_URL = "https://github.com/o/r/issues/12";

const triage = (over: Partial<Triage> = {}): Triage => ({
  category: "bug",
  confidence: 0.9,
  severity: "major",
  area: "export",
  summary: "CSV export button does nothing on the reports page.",
  repro: { steps: ["Open reports", "Click Export CSV"], expected: "A CSV downloads", actual: "Nothing happens" },
  missing: [],
  evidence: ["Export button does nothing"],
  answerDraft: null,
  ...over,
});

const request = (over: Partial<CustomerRequest> = {}): CustomerRequest => ({
  sessionId: SESSION,
  websiteId: "site-1",
  customer: { email: EMAIL },
  messages: [
    { from: "user", at: "2026-11-16T10:00:00.000Z", text: `Hi, I'm ${EMAIL}, call +44 20 7946 0958. Export button does nothing.` },
    { from: "operator", at: "2026-11-16T10:01:00.000Z", text: "Which page?" },
    { from: "user", at: "2026-11-16T10:02:00.000Z", text: "Reports, every time I click Export CSV." },
  ],
  segments: ["triage"],
  ...over,
});

const event = (req: CustomerRequest | null = request(), kind: "segments" | "resolved" = "segments", segments = ["triage"]): CrispSessionEvent => ({
  source: "crisp",
  kind,
  externalId: `${SESSION}:${kind === "segments" ? "triage" : "resolved"}`,
  receivedAt: "2026-11-16T10:05:00.000Z",
  payload: { websiteId: "site-1", sessionId: SESSION, segments, request: req },
});

const log: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** A fake of Crisp, OpenRouter and GitHub. `verdicts` are the model replies in order. */
function services(verdicts: string[], openIssues: unknown[] = []) {
  const replies = [...verdicts];
  return mockFetch((c) => {
    const url = new URL(c.url);
    if (url.host === "openrouter.ai") return json(200, { choices: [{ message: { content: replies.shift() ?? "" } }] });
    if (url.host === "api.crisp.chat" && c.method === "GET") return json(200, { data: { segments: ["triage"] } });
    if (url.host === "api.crisp.chat") return json(200, { error: false, reason: "dispatched", data: {} });
    if (c.method === "GET" && url.pathname === "/repos/o/r/issues") return json(200, openIssues);
    if (c.method === "GET" && url.pathname === "/repos/o/r") return json(200, { default_branch: "main" });
    if (url.pathname === "/repos/o/r/labels") return json(201, {});
    if (url.pathname === "/repos/o/r/issues") return json(201, { number: 12, html_url: ISSUE_URL });
    if (url.pathname.endsWith("/dispatches")) return new Response(null, { status: 204 });
    return json(404, {});
  });
}

const make = (f: typeof fetch, over: Partial<CrispTriageConfig> = {}) =>
  createCrispTriage({
    crisp: { websiteId: "site-1", identifier: "id", key: "key" },
    openrouter: { apiKey: "or-key", triageModel: "anthropic/claude-haiku-5.5", escalationModel: "anthropic/claude-sonnet-5.5" },
    github: { repo: { owner: "o", name: "r" }, token: "gh-token" },
    triggerSegment: "Triage",
    autoTriage: false,
    mode: "fix",
    minConfidence: 0.7,
    areas: ["export", "billing"],
    autofixAreas: ["export"],
    workflowFile: "codex-issue-fix.yml",
    fetch: f,
    ...over,
  });

const writes = (calls: { url: string; method: string }[]) =>
  calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${new URL(c.url).host}${new URL(c.url).pathname}`);

describe("crisp triage route table", () => {
  const ctx = (over: Partial<Triage> = {}, autofixAreas = ["export"]) => ({ triage: triage(over), minConfidence: 0.7, autofixAreas });

  const cases: [string, Partial<Triage>, string, unknown][] = [
    ["spam is dropped", { category: "spam" }, "spam", { kind: "drop", reason: "spam" }],
    ["how_to drafts an answer", { category: "how_to", answerDraft: "Use Settings > Export." }, "how_to", { kind: "answer", draft: "Use Settings > Export." }],
    ["a low-confidence how_to needs info", { category: "how_to", confidence: 0.5 }, "incomplete", { kind: "needs_info", questions: [expect.any(String)] }],
    ["a bug with open questions needs info", { missing: ["Which browser?"] }, "incomplete", { kind: "needs_info", questions: ["Which browser?"] }],
    ["a bug without repro needs info", { category: "regression", repro: null }, "incomplete", { kind: "needs_info", questions: [expect.any(String)] }],
    ["low confidence needs info", { category: "feature_request", confidence: 0.5 }, "incomplete", { kind: "needs_info", questions: [expect.any(String)] }],
    ["a feature request is an issue", { category: "feature_request", repro: null }, "tracked", { kind: "issue", labels: ["feature-request"] }],
    ["performance is an issue", { category: "performance" }, "tracked", { kind: "issue", labels: ["performance"] }],
    ["data_fix is an issue labelled data", { category: "data_fix" }, "tracked", { kind: "issue", labels: ["data"] }],
    ["account_billing is never a fix, even in an autofix area", { category: "account_billing" }, "tracked", { kind: "issue", labels: ["account-billing"] }],
    ["a non-blocker bug in an autofix area is a fix", {}, "autofix", { kind: "fix", labels: ["bug", "autofix"] }],
    ["a blocker goes to people", { severity: "blocker" }, "bug", { kind: "issue", labels: ["bug"] }],
    ["a bug outside the autofix areas is an issue", { area: "billing" }, "bug", { kind: "issue", labels: ["bug"] }],
    ["anything else is an unsure issue", { category: "other" }, "unsure", { kind: "issue", labels: ["triage-unsure"] }],
  ];
  for (const [name, over, rule, decision] of cases) {
    test(name, () => expect(route(ctx(over))).toEqual({ rule, decision: decision as never }));
  }

  test("an unknown area is never a fix", () => {
    expect(route(ctx({ area: "unknown" }, ["unknown"])).decision.kind).toBe("issue");
  });

  test("mode caps the decision", () => {
    const fix = { kind: "fix", labels: ["bug", "autofix"] } as const;
    expect(applyMode(fix, "shadow")).toEqual({ decision: fix, github: false });
    expect(applyMode(fix, "issue")).toEqual({ decision: { kind: "issue", labels: ["bug"] }, github: true });
    expect(applyMode(fix, "fix")).toEqual({ decision: fix, github: true });
  });
});

describe("crisp-triage", () => {
  const none = services([]).fn;

  test("matches the trigger segment case-insensitively, once, and resolved sessions only with auto triage", () => {
    expect(make(none).matches(event())).toBe(true);
    expect(make(none).matches(event(request(), "segments", ["vip"]))).toBe(false);
    expect(make(none).matches(event(request(), "segments", ["TRIAGE", "triage:issue"]))).toBe(false);
    expect(make(none).matches(event(request({ segments: ["triage", "triage:fix"] })))).toBe(false);
    expect(make(none).matches(event(request(), "resolved", []))).toBe(false);
    expect(make(none, { autoTriage: true }).matches(event(request(), "resolved", []))).toBe(true);
  });

  test("shadow mode writes only the Crisp note and status segment", async () => {
    const { fn, calls } = services([JSON.stringify(triage()), JSON.stringify(triage())]);
    await make(fn, { mode: "shadow" }).run(event(), { log });
    expect(writes(calls)).toEqual([
      "POST openrouter.ai/api/v1/chat/completions",
      "POST openrouter.ai/api/v1/chat/completions",
      `POST api.crisp.chat/v1/website/site-1/conversation/${SESSION}/message`,
      `PATCH api.crisp.chat/v1/website/site-1/conversation/${SESSION}/meta`,
    ]);
    const note = calls.find((c) => c.url.endsWith("/message"))?.body as { type: string; content: string };
    expect(note.type).toBe("note");
    expect(note.content).toStartWith("[automation-server triage]");
    expect(note.content).toContain("Decision: fix.");
    expect(note.content).toContain("Mode shadow: nothing was written to GitHub.");
    expect(calls.find((c) => c.url.endsWith("/meta"))?.body).toEqual({ segments: ["triage", "triage:fix"] });
  });

  test("fix mode escalates a bug, opens a marked and labelled issue and dispatches the fix workflow", async () => {
    const { fn, calls } = services([JSON.stringify(triage({ confidence: 0.6 })), JSON.stringify(triage())]);
    await make(fn).run(event(), { log });

    const models = calls.filter((c) => c.url.includes("openrouter")).map((c) => (c.body as { model: string }).model);
    expect(models).toEqual(["anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5"]);

    const issue = calls.find((c) => c.method === "POST" && c.url.endsWith("/repos/o/r/issues"))?.body as { title: string; body: string; labels: string[] };
    expect(issue.body.split("\n")).toContain(`Crisp Session: ${SESSION}`);
    expect(issue.labels).toEqual(["crisp", "area:export", "severity:major", "bug", "autofix"]);
    expect(issue.title).toBe("[Crisp] CSV export button does nothing on the reports page.");

    const dispatch = calls.find((c) => c.url.endsWith("/dispatches"));
    expect(dispatch?.url).toBe("https://api.github.com/repos/o/r/actions/workflows/codex-issue-fix.yml/dispatches");
    expect(dispatch?.body).toEqual({ ref: "main", inputs: { issue_number: "12" } });

    const note = (calls.find((c) => c.url.endsWith("/message"))?.body as { content: string }).content;
    expect(note).toContain(ISSUE_URL);
    expect(calls.find((c) => c.url.endsWith("/meta"))?.body).toEqual({ segments: ["triage", "triage:fix"] });
  });

  test("a failed dispatch still posts the note and status segment, then fails the run", async () => {
    const base = services([JSON.stringify(triage()), JSON.stringify(triage())]).fn;
    const calls: string[] = [];
    const fn = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/dispatches")) return json(404, { message: "Not Found" });
      return base(input, init);
    }) as typeof fetch;
    const err = (await make(fn).run(event(), { log }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("was not found");
    expect(calls.some((c) => c.startsWith("POST") && c.endsWith("/message"))).toBe(true);
    expect(calls.some((c) => c.startsWith("PATCH") && c.endsWith("/meta"))).toBe(true);
  });

  test("the status segment is merged into the segments Crisp has when the triage ends", async () => {
    const base = services([JSON.stringify(triage()), JSON.stringify(triage())]).fn;
    let patched: unknown;
    const fn = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/conversation/session_abc") && (init?.method ?? "GET") === "GET") {
        return json(200, { data: { segments: ["triage", "vip-added-later"] } });
      }
      if (init?.method === "PATCH") patched = JSON.parse(String(init.body));
      return base(input, init);
    }) as typeof fetch;
    await make(fn).run(event(), { log });
    expect(patched).toEqual({ segments: ["triage", "vip-added-later", "triage:fix"] });
  });

  test("issue mode opens the issue without autofix and dispatches nothing", async () => {
    const { fn, calls } = services([JSON.stringify(triage()), JSON.stringify(triage())]);
    await make(fn, { mode: "issue" }).run(event(), { log });
    const issue = calls.find((c) => c.method === "POST" && c.url.endsWith("/repos/o/r/issues"))?.body as { labels: string[] };
    expect(issue.labels).toEqual(["crisp", "area:export", "severity:major", "bug"]);
    expect(calls.some((c) => c.url.endsWith("/dispatches"))).toBe(false);
  });

  test("an open issue with the session marker drops the request without asking the model", async () => {
    const { fn, calls } = services([], [{ html_url: "https://github.com/o/r/issues/3", body: `x\nCrisp Session: ${SESSION}\n` }]);
    await make(fn).run(event(), { log });
    expect(new URL(calls[0]!.url).searchParams.get("labels")).toBe("crisp");
    expect(writes(calls)).toEqual([
      `POST api.crisp.chat/v1/website/site-1/conversation/${SESSION}/message`,
      `PATCH api.crisp.chat/v1/website/site-1/conversation/${SESSION}/meta`,
    ]);
    expect((calls.find((c) => c.url.endsWith("/message"))?.body as { content: string }).content).toContain("https://github.com/o/r/issues/3");
    expect(calls.find((c) => c.url.endsWith("/meta"))?.body).toEqual({ segments: ["triage", "triage:drop"] });
  });

  test("a conversation without customer text asks for details without asking the model", async () => {
    const { fn, calls } = services([]);
    await make(fn).run(event(request({ messages: [{ from: "operator", at: "2026-11-16T10:00:00.000Z", text: "Hello?" }] })), { log });
    expect(calls.some((c) => c.url.includes("openrouter"))).toBe(false);
    expect(calls.find((c) => c.url.endsWith("/meta"))?.body).toEqual({ segments: ["triage", "triage:needs-info"] });
  });

  test("an invalid model reply fails the run before anything is written", async () => {
    const { fn, calls } = services(["not json"]);
    await expect(make(fn).run(event(), { log })).rejects.toThrow("returned no valid JSON");
    expect(writes(calls)).toEqual(["POST openrouter.ai/api/v1/chat/completions"]);
  });

  test("an unloaded conversation fails the run", async () => {
    await expect(make(none).run(event(null), { log })).rejects.toThrow("could not be loaded");
  });

  test("the customer's email and phone never reach the model or the GitHub issue", async () => {
    const echo = triage({ summary: `Customer ${EMAIL} cannot export`, evidence: [`I'm ${EMAIL}, call +44 20 7946 0958`] });
    const { fn, calls } = services([JSON.stringify(echo), JSON.stringify(echo)]);
    await make(fn).run(event(), { log });
    const sentToModel = calls.filter((c) => c.url.includes("openrouter")).map((c) => JSON.stringify(c.body)).join("\n");
    expect(sentToModel).toContain("Export button does nothing");
    expect(sentToModel).not.toContain(EMAIL);
    expect(sentToModel).not.toContain("7946");
    const issue = JSON.stringify(calls.find((c) => c.method === "POST" && c.url.endsWith("/repos/o/r/issues"))?.body);
    expect(issue).not.toContain(EMAIL);
    expect(issue).not.toContain("7946");
  });

  test("issue and fix modes need GitHub", () => {
    expect(() => make(none, { mode: "issue", github: null })).toThrow("needs the GitHub token");
    expect(() => make(none, { mode: "shadow", github: null })).not.toThrow();
  });
});

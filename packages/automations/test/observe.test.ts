import { describe, expect, test } from "bun:test";
import { toMicroUsd, type GithubEffect, type LlmCall, type Observer } from "@automation-server/ledger";
import { z } from "zod";

import { createGithubClient } from "../src/github";
import { createOpenRouterClient } from "../src/openrouter";
import { json, mockFetch } from "./github.test";

const recorder = () => {
  const llm: LlmCall[] = [];
  const github: GithubEffect[] = [];
  const observe: Observer = { llm: (c) => void llm.push(c), github: (e) => void github.push(e) };
  return { llm, github, observe };
};

const schema = z.object({ answer: z.enum(["yes", "no"]) });
const ask = (fn: typeof fetch, observe: Observer) =>
  createOpenRouterClient({ apiKey: "sk-or-v1-key", fetch: fn, observe }).structured({ model: "anthropic/claude-haiku-5.5", system: "s", user: "u", name: "triage", schema });

describe("OpenRouter usage", () => {
  test("asks for usage and reports tokens and the dollar cost as micro-dollars", async () => {
    const rec = recorder();
    const { fn, calls } = mockFetch(() =>
      json(200, {
        id: "gen-123",
        model: "anthropic/claude-4.5-haiku-20251001",
        choices: [{ message: { content: '{"answer":"yes"}' } }],
        usage: { prompt_tokens: 4100, completion_tokens: 380, total_tokens: 4480, cost: 0.0132 },
      }),
    );
    expect(await ask(fn, rec.observe)).toEqual({ answer: "yes" });
    expect(calls[0]?.body).toMatchObject({ usage: { include: true } });
    expect(rec.llm).toEqual([
      {
        provider: "openrouter",
        model: "anthropic/claude-4.5-haiku-20251001",
        purpose: "triage",
        generationId: "gen-123",
        promptTokens: 4100,
        completionTokens: 380,
        cost: toMicroUsd(0.0132),
        at: expect.any(String),
        durationMs: expect.any(Number),
      },
    ]);
  });

  test("a reply without usage is recorded as unpriced with zero tokens, under the requested model", async () => {
    const rec = recorder();
    await ask(mockFetch(() => json(200, { choices: [{ message: { content: '{"answer":"no"}' } }] })).fn, rec.observe);
    expect(rec.llm[0]).toMatchObject({ model: "anthropic/claude-haiku-5.5", generationId: null, promptTokens: 0, completionTokens: 0, cost: null });
  });

  test("an answer that misses the schema is still counted, because it was paid for; an HTTP error is not", async () => {
    const rec = recorder();
    const paid = { choices: [{ message: { content: '{"answer":"maybe"}' } }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 } };
    await expect(ask(mockFetch(() => json(200, paid)).fn, rec.observe)).rejects.toThrow("does not match the schema");
    await expect(ask(mockFetch(() => json(429, { error: { message: "rate limited" } })).fn, rec.observe)).rejects.toThrow("status 429");
    expect(rec.llm.map((c) => c.cost)).toEqual([toMicroUsd(0.001)]);
  });
});

describe("GitHub effects", () => {
  const make = (fn: typeof fetch, observe: Observer) => createGithubClient({ repo: { owner: "Acme", name: "App" }, token: "ghp_token", fetch: fn, observe });

  test("a created issue is reported with its number and URL", async () => {
    const rec = recorder();
    await make(mockFetch(() => json(201, { number: 12, html_url: "https://github.com/Acme/App/issues/12" })).fn, rec.observe).createIssue({ title: "t", body: "b", labels: [] });
    expect(rec.github).toEqual([{ kind: "issue_created", repo: "Acme/App", number: 12, url: "https://github.com/Acme/App/issues/12" }]);
  });

  test("a dispatch asks for run details and reports the run id when GitHub returns one, null on a bare 204", async () => {
    const rec = recorder();
    const withDetails = mockFetch(() => json(200, { workflow_run_id: 987, run_url: "x", html_url: "y" }));
    await make(withDetails.fn, rec.observe).dispatchWorkflow("codex-issue-fix.yml", "main", { issue_number: "12" });
    await make(mockFetch(() => new Response(null, { status: 204 })).fn, rec.observe).dispatchWorkflow("codex-issue-fix.yml", "main", { issue_number: "13" });
    expect(withDetails.calls[0]?.body).toEqual({ ref: "main", inputs: { issue_number: "12" }, return_run_details: true });
    expect(rec.github).toEqual([
      { kind: "workflow_dispatched", repo: "Acme/App", workflowFile: "codex-issue-fix.yml", ref: "main", inputs: { issue_number: "12" }, workflowRunId: 987 },
      { kind: "workflow_dispatched", repo: "Acme/App", workflowFile: "codex-issue-fix.yml", ref: "main", inputs: { issue_number: "13" }, workflowRunId: null },
    ]);
  });

  test("a failed write reports nothing", async () => {
    const rec = recorder();
    const fail = mockFetch(() => json(422, { message: "no" })).fn;
    await expect(make(fail, rec.observe).dispatchWorkflow("codex-issue-fix.yml", "main", {})).rejects.toThrow();
    await expect(make(fail, rec.observe).createIssue({ title: "t", body: "b", labels: [] })).rejects.toThrow();
    expect(rec.github).toEqual([]);
  });
});

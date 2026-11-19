import { describe, expect, test } from "bun:test";
import { redactPayload, redactSecretShapes } from "../src/redact";

describe("redactPayload", () => {
  test("replaces values of sensitive keys at any depth, inside arrays too", () => {
    const input = { user: { email: "a@b.c", password: "p" }, list: [{ apiKey: "k", n: 1 }, "plain"], deep: { a: { b: { token: "t" } } } };
    expect(redactPayload(input)).toEqual({
      user: { email: "a@b.c", password: "[redacted]" },
      list: [{ apiKey: "[redacted]", n: 1 }, "plain"],
      deep: { a: { b: { token: "[redacted]" } } },
    });
  });

  test("matches keys case-insensitively and by substring", () => {
    const out = redactPayload({ Authorization: "Bearer x", "X-Api-Key": "k", api_key: "k", Set_Cookie: "c", clientSecret: "s", message: "my password is hunter2" });
    expect(out).toEqual({
      Authorization: "[redacted]",
      "X-Api-Key": "[redacted]",
      api_key: "[redacted]",
      Set_Cookie: "[redacted]",
      clientSecret: "[redacted]",
      message: "my password is hunter2",
    });
  });

  test("redacts a whole subtree under a sensitive key", () => {
    expect(redactPayload({ token: { value: "x" } })).toEqual({ token: "[redacted]" });
  });

  test("does not mutate its input", () => {
    const input = { a: { token: "t" }, b: [{ secret: "s" }] };
    const snapshot = structuredClone(input);
    redactPayload(input);
    expect(input).toEqual(snapshot);
  });

  test("returns non-object input unchanged", () => {
    expect(redactPayload("token")).toBe("token");
    expect(redactPayload(5)).toBe(5);
    expect(redactPayload(null)).toBeNull();
    expect(redactPayload(undefined)).toBeUndefined();
    expect(redactPayload(["a", 1])).toEqual(["a", 1]);
  });

  test("matches the wider key list", () => {
    const out = redactPayload({ privateKey: "k", signature: "s", credentials: "c", sessionId: "i", plain: "ok" });
    expect(out).toEqual({ privateKey: "[redacted]", signature: "[redacted]", credentials: "[redacted]", sessionId: "[redacted]", plain: "ok" });
  });
});

describe("secret-shaped values", () => {
  const fakeJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
  const shapes: Record<string, string> = {
    slackBot: "xoxb-1111111111-2222222222-fakefakefake",
    slackUser: "xoxp-1111111111-2222222222-fakefakefake",
    slackApp: "xapp-1-A111-2222-fakefakefakefake",
    githubPat: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    githubOauth: "gho_abcdefghijklmnopqrstuvwxyz0123456789",
    githubServer: "ghs_abcdefghijklmnopqrstuvwxyz0123456789",
    githubFine: "github_pat_11AAAAAAA0abcdefghijklmnop_qrstuvwxyz",
    openrouter: "sk-or-v1-0123456789abcdef0123456789abcdef",
    linear: "lin_api_abcdefghijklmnopqrstuvwxyz012345",
    posthogPersonal: "phx_abcdefghijklmnopqrstuvwxyz012345",
    posthogProject: "phc_abcdefghijklmnopqrstuvwxyz012345",
    bearer: "Bearer abc123.def456-ghi789",
    jwt: fakeJwt,
    webhook: "https://hooks.slack.com/services/T000/B000/fakefakefake",
  };

  for (const [name, secret] of Object.entries(shapes)) {
    test(`redacts a ${name} value and keeps the surrounding text`, () => {
      expect(redactPayload(`before ${secret} after`)).toBe("before [redacted] after");
      expect(redactPayload({ note: secret })).toEqual({ note: "[redacted]" });
    });
  }

  test("redacts at any depth and inside arrays", () => {
    const out = redactPayload({ a: [{ b: { c: ["x", `see ${shapes.githubPat}`] } }] });
    expect(out).toEqual({ a: [{ b: { c: ["x", "see [redacted]"] } }] });
  });

  test("redacts several secrets in one string", () => {
    expect(redactSecretShapes(`${shapes.linear} and ${shapes.openrouter}`)).toBe("[redacted] and [redacted]");
  });

  test("leaves lookalikes and short values alone", () => {
    for (const text of ["sk-short", "task-force-sk-1234567890123456789012345", "ghp_short", "eyJ.only", "xoxb-", "keywords here", "Bearer x", "bearer of bad news"]) {
      expect(redactPayload(text)).toBe(text);
    }
  });

  test("does not mutate its input", () => {
    const input = { a: [shapes.githubPat], b: { c: shapes.bearer } };
    const snapshot = structuredClone(input);
    redactPayload(input);
    expect(input).toEqual(snapshot);
  });

  test("hostile long strings stay linear", () => {
    const hostile = [
      "a".repeat(200_000),
      "sk-".repeat(70_000),
      `sk-${"a".repeat(10)}`.repeat(20_000),
      "eyJa.".repeat(40_000),
      "Bearer ".repeat(30_000),
      `Bearer ${"-".repeat(200_000)}x`.slice(0, 200_000),
      "xoxb-".repeat(40_000),
      "https://hooks.slack.com/".repeat(10_000),
    ];
    for (const text of hostile) {
      const started = performance.now();
      redactPayload({ text });
      expect(performance.now() - started).toBeLessThan(100);
    }
  });
});

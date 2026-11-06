import { describe, expect, test } from "bun:test";

import { createGithubClient } from "../src/github";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

export function mockFetch(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

const TOKEN = "ghp_SUPERSECRETTOKEN";
const make = (f: typeof fetch) => createGithubClient({ repo: { owner: "o", name: "r" }, token: TOKEN, fetch: f });

describe("github client", () => {
  test("sends required headers and posts labels", async () => {
    const { fn, calls } = mockFetch(() => json(201, {}));
    await make(fn).ensureLabels(["sentry", "level:error"]);
    expect(calls.map((c) => c.url)).toEqual(["https://api.github.com/repos/o/r/labels", "https://api.github.com/repos/o/r/labels"]);
    expect(calls[0]?.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    expect(calls[0]?.headers["User-Agent"]).toBeTruthy();
    expect(calls[1]?.body).toEqual({ name: "level:error" });
  });

  test("422 already_exists is ok, other 422 throws", async () => {
    const ok = mockFetch(() => json(422, { errors: [{ code: "already_exists" }] }));
    await make(ok.fn).ensureLabels(["x"]);
    const bad = mockFetch(() => json(422, { errors: [{ code: "invalid" }] }));
    await expect(make(bad.fn).ensureLabels(["x"])).rejects.toThrow("status 422");
  });

  test("403 throws naming status and endpoint, never token", async () => {
    const { fn } = mockFetch(() => json(403, { message: `bad ${TOKEN} user@x.com` }));
    const err = await make(fn).ensureLabels(["x"]).catch((e: Error) => e);
    expect((err as Error).message).toStartWith("GitHub API POST /repos/o/r/labels failed with status 403");
    expect((err as Error).message).not.toContain("user@x.com");
    expect((err as Error).message).not.toContain(TOKEN);
  });

  test("network error does not leak", async () => {
    const f = (async () => { throw new Error(`boom ${TOKEN}`); }) as unknown as typeof fetch;
    const err = await make(f).ensureLabels(["x"]).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(TOKEN);
  });

  test("find: lists open sentry issues and verifies the exact marker line", async () => {
    const { fn, calls } = mockFetch(() =>
      json(200, [
        { html_url: "https://github.com/o/r/issues/1", body: "x\nSentry Issue: 45010\n" },
        { html_url: "https://github.com/o/r/pull/9", body: "Sentry Issue: 4501", pull_request: {} },
        { html_url: "https://github.com/o/r/issues/2", body: "link\nSentry Issue: 4501\n- Level" },
      ]),
    );
    expect(await make(fn).findOpenIssueBySentryId("4501")).toBe("https://github.com/o/r/issues/2");
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/repos/o/r/issues");
    expect(url.searchParams.get("state")).toBe("open");
    expect(url.searchParams.get("labels")).toBe("sentry");
  });

  test("find: no exact match returns null; null body and pull requests tolerated", async () => {
    const { fn } = mockFetch(() =>
      json(200, [{ html_url: "u", body: null }, { html_url: "v", body: "Sentry Issue: 45011" }, { html_url: "p", body: "Sentry Issue: 4501", pull_request: {} }]),
    );
    expect(await make(fn).findOpenIssueBySentryId("4501")).toBeNull();
  });

  test("find: follows pages until a short page and stops after finding a hit", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ html_url: `u${i}`, body: "Sentry Issue: 1" }));
    const { fn, calls } = mockFetch((c) =>
      json(200, new URL(c.url).searchParams.get("page") === "1" ? full : [{ html_url: "hit", body: "Sentry Issue: 4501" }]),
    );
    expect(await make(fn).findOpenIssueBySentryId("4501")).toBe("hit");
    expect(calls).toHaveLength(2);
  });

  test("find: non-2xx throws", async () => {
    const { fn } = mockFetch(() => json(500, {}));
    await expect(make(fn).findOpenIssueBySentryId("1")).rejects.toThrow("status 500");
  });

  test("createIssue returns number and url; throws on failure", async () => {
    const good = mockFetch(() => json(201, { number: 7, html_url: "https://github.com/o/r/issues/7", extra: 1 }));
    expect(await make(good.fn).createIssue({ title: "t", body: "b", labels: ["a"] })).toEqual({ number: 7, html_url: "https://github.com/o/r/issues/7" });
    expect(good.calls[0]?.body).toEqual({ title: "t", body: "b", labels: ["a"] });
    const bad = mockFetch(() => json(500, { message: "Server Error" }));
    const err = await make(bad.fn).createIssue({ title: "t", body: "SECRET-CONTENT", labels: [] }).catch((e: Error) => e);
    expect((err as Error).message).toBe("GitHub API POST /repos/o/r/issues failed with status 500: Server Error");
    expect((err as Error).message).not.toContain("SECRET-CONTENT");
    expect((err as Error).message).not.toContain(TOKEN);
  });

  test("find: 422 surfaces GitHub's validation message", async () => {
    const { fn } = mockFetch(() =>
      json(422, { message: "Validation Failed", errors: [{ message: "The listed users and repositories cannot be searched" }] }),
    );
    await expect(make(fn).findOpenIssueBySentryId("1")).rejects.toThrow(
      "status 422: Validation Failed; The listed users and repositories cannot be searched",
    );
  });

  test("custom apiBaseUrl", async () => {
    const { fn, calls } = mockFetch(() => json(201, {}));
    await createGithubClient({ repo: { owner: "o", name: "r" }, token: "t", fetch: fn, apiBaseUrl: "https://ghe.local/api/v3/" }).ensureLabels(["a"]);
    expect(calls[0]?.url).toBe("https://ghe.local/api/v3/repos/o/r/labels");
  });
});

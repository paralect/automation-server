import type { Logger } from "@automation-server/core";
import { createSqliteSettingsStore, envFor, resolveConfig } from "@automation-server/settings";
import { describe, expect, test } from "bun:test";
import { UNOBSERVED } from "@automation-server/ledger";

import { INTEGRATION_MODULES } from "../src/integrations/registry";
import { createRuntime } from "../src/runtime";

const log: Logger = { info() {}, warn() {}, error() {} };
const GH_TOKEN = "ghp_probeSecretToken1234567890";
const SENTRY_TOKEN = "sntrys_probeSecretToken1234567890";

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

const setup = (env: Record<string, string>, handler: Handler, testTimeoutMs?: number) => {
  const store = createSqliteSettingsStore({ path: ":memory:", encryptionKey: "k" });
  const requests: { url: string; auth: string | null }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url: url.href, auth: new Headers(init?.headers).get("authorization") });
    return handler(url, init);
  }) as typeof globalThis.fetch;
  const runtime = createRuntime({ observerFor: () => UNOBSERVED,
    modules: INTEGRATION_MODULES,
    projects: () => ["default"],
    resolve: (p) => resolveConfig(store.project(p), envFor(p, env)),
    deps: { log, fetch },
    testTimeoutMs,
  });
  return { runtime, requests, store };
};

const githubFetch = (expiration?: string): Handler => (url) =>
  url.pathname === "/user"
    ? Response.json({ login: "octo" }, { headers: expiration === undefined ? {} : { "github-authentication-token-expiration": expiration } })
    : Response.json({ private: false });

describe("github probe expiry", () => {
  test("reads the expiration header into an ISO expiresAt", async () => {
    const { runtime } = setup({ GITHUB_TOKEN: GH_TOKEN, GITHUB_REPO: "acme/widgets" }, githubFetch("2026-12-01 10:00:00 UTC"));
    expect(await runtime.test("default", "github")).toMatchObject({ ok: true, expiresAt: "2026-12-01T10:00:00.000Z" });
  });

  test("a classic token without the header, or an unparseable one, gives no expiry", async () => {
    for (const header of [undefined, "", "never"]) {
      const result = await setup({ GITHUB_TOKEN: GH_TOKEN }, githubFetch(header)).runtime.test("default", "github");
      expect(result.ok).toBe(true);
      expect(result.expiresAt).toBeUndefined();
    }
  });
});

describe("sentry probe", () => {
  const env = { SENTRY_CLIENT_SECRET: "cs", SENTRY_AUTH_TOKEN: SENTRY_TOKEN };

  test("calls the API root with the bearer token and never echoes it", async () => {
    const { runtime, requests } = setup({ ...env, SENTRY_API_BASE_URL: "https://sentry.example.com/" }, () => Response.json({}));
    const result = await runtime.test("default", "sentry");
    expect(result).toMatchObject({ ok: true, available: true });
    expect(requests).toEqual([{ url: "https://sentry.example.com/api/0/", auth: `Bearer ${SENTRY_TOKEN}` }]);
    expect(JSON.stringify(result)).not.toContain(SENTRY_TOKEN);
  });

  test("never follows a redirect, so the token cannot be forwarded", async () => {
    const redirects: RequestInit["redirect"][] = [];
    await setup(env, (_url, init) => (redirects.push(init?.redirect), Response.json({}))).runtime.test("default", "sentry");
    expect(redirects).toEqual(["error"]);
  });

  test("401 and 403 are rejections, other statuses are failures", async () => {
    for (const status of [401, 403]) {
      expect(await setup(env, () => new Response("{}", { status })).runtime.test("default", "sentry")).toMatchObject({ ok: false, message: expect.stringContaining(String(status)) });
    }
    expect(await setup(env, () => new Response("{}", { status: 500 })).runtime.test("default", "sentry")).toMatchObject({ ok: false, message: expect.stringContaining("500") });
  });

  test("without an auth token it is ok, says enrichment is off and makes no request", async () => {
    const { runtime, requests } = setup({ SENTRY_CLIENT_SECRET: "cs" }, () => Response.json({}));
    expect(await runtime.test("default", "sentry")).toMatchObject({ ok: true, message: "No auth token configured, enrichment is off" });
    expect(requests).toEqual([]);
  });
});

describe("openrouter probe expiry", () => {
  test("maps expires_at from /key and tolerates its absence", async () => {
    const withExpiry = setup({}, () => Response.json({ data: { label: "prod", usage: 1, expires_at: "2026-12-05T00:00:00Z" } }));
    withExpiry.store.apply({ set: [{ key: "openrouter.apiKey", json: '"or-key"', secret: true }] });
    expect(await withExpiry.runtime.test("default", "openrouter")).toMatchObject({ ok: true, expiresAt: "2026-12-05T00:00:00.000Z" });
    const none = setup({}, () => Response.json({ data: { label: "prod", expires_at: null } }));
    none.store.apply({ set: [{ key: "openrouter.apiKey", json: '"or-key"', secret: true }] });
    const without = await none.runtime.test("default", "openrouter");
    expect(without.ok).toBe(true);
    expect(without.expiresAt).toBeUndefined();
  });
});

describe("test timeout", () => {
  test("a hanging fetch that honours the abort signal gives a timed out result", async () => {
    let aborted = false;
    const hang: Handler = (_url, init) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    const result = await setup({ GITHUB_TOKEN: GH_TOKEN }, hang, 30).runtime.test("default", "github");
    expect(result).toEqual({ ok: false, available: true, message: "Connection test timed out after 0.03 s" });
    expect(aborted).toBe(true);
  });

  test("a hanging fetch that ignores the signal still times out", async () => {
    const result = await setup({ SENTRY_CLIENT_SECRET: "cs", SENTRY_AUTH_TOKEN: SENTRY_TOKEN }, () => new Promise<Response>(() => {}), 30).runtime.test("default", "sentry");
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("timed out") });
  });
});

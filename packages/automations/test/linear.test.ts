import { describe, expect, test } from "bun:test";

import { createLinearClient, LinearApiError } from "../src/linear";

const KEY = "lin_api_SECRETKEY1234567890abcdef";

type Call = { url: string; headers: Record<string, string>; body: { query: string; variables: Record<string, unknown> }; redirect: RequestInit["redirect"] };

const stub = (reply: (call: Call) => Response) => {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)), redirect: init?.redirect };
    calls.push(call);
    return reply(call);
  }) as unknown as typeof fetch;
  return { fn, calls };
};

const data = (value: unknown, status = 200) => new Response(JSON.stringify({ data: value }), { status });

describe("linear client", () => {
  test("viewer sends the key as the authorization header only", async () => {
    const { fn, calls } = stub(() => data({ viewer: { name: "Ada" }, organization: { name: "Acme" } }));
    expect(await createLinearClient({ apiKey: KEY, fetch: fn }).viewer()).toEqual({ name: "Ada", organization: "Acme" });
    expect(calls[0]!.url).toBe("https://api.linear.app/graphql");
    expect(calls[0]!.headers.authorization).toBe(KEY);
    expect(JSON.stringify(calls[0]!.body)).not.toContain(KEY);
    expect(calls[0]!.redirect).toBe("error");
  });

  test("searchIssues maps nodes and passes the term as a variable", async () => {
    const { fn, calls } = stub(() =>
      data({ searchIssues: { nodes: [{ identifier: "ENG-1", title: "Billing bug", url: "https://linear.app/x/ENG-1", state: { name: "Todo" }, assignee: null }] } }),
    );
    const out = await createLinearClient({ apiKey: KEY, fetch: fn }).searchIssues("billing", 5);
    expect(out).toEqual([{ identifier: "ENG-1", title: "Billing bug", url: "https://linear.app/x/ENG-1", state: "Todo", assignee: null }]);
    expect(calls[0]!.body.variables).toEqual({ term: "billing", first: 5 });
  });

  test("getIssue returns the description, labels and comments, and null for a missing issue", async () => {
    const issue = {
      identifier: "ENG-2",
      title: "T",
      url: "u",
      state: { name: "Done" },
      assignee: { name: "Bo" },
      description: "body",
      labels: { nodes: [{ name: "bug" }] },
      comments: { nodes: [{ body: "hi", user: { name: "Cy" } }] },
    };
    const found = createLinearClient({ apiKey: KEY, fetch: stub(() => data({ issue })).fn });
    expect(await found.getIssue("ENG-2")).toMatchObject({ description: "body", labels: ["bug"], comments: [{ author: "Cy", body: "hi" }] });
    const missing = createLinearClient({ apiKey: KEY, fetch: stub(() => data({ issue: null })).fn });
    expect(await missing.getIssue("ENG-9")).toBeNull();
  });

  test("a rejected key and GraphQL errors become LinearApiError without the key", async () => {
    const rejected = createLinearClient({ apiKey: KEY, fetch: stub(() => new Response("{}", { status: 401 })).fn });
    const error = await rejected.viewer().catch((e) => e);
    expect(error).toBeInstanceOf(LinearApiError);
    expect(error.message).toContain("rejected");

    const gql = createLinearClient({
      apiKey: KEY,
      fetch: stub(() => new Response(JSON.stringify({ errors: [{ message: `bad ${KEY}` }] }), { status: 200 })).fn,
    });
    const gqlError = await gql.viewer().catch((e) => e);
    expect(gqlError.message).not.toContain(KEY);
  });

  test("a network failure never echoes the key", async () => {
    const client = createLinearClient({
      apiKey: KEY,
      fetch: (async () => {
        throw new Error(`connect to ${KEY} failed`);
      }) as unknown as typeof fetch,
    });
    const error = await client.viewer().catch((e) => e);
    expect(error.message).toBe("Linear request failed: network error");
  });
});

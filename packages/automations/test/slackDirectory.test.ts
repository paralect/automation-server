import { describe, expect, test } from "bun:test";

import { createSlackBotClient, SlackApiError } from "../src/slackBot/client";

const TOKEN = "xoxb-secret-token";

type Call = { url: string; params: URLSearchParams; type: string | undefined; auth: string | undefined; redirect: RequestInit["redirect"] };

const stub = (reply: (call: Call, n: number) => unknown) => {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    const call = { url: String(input), params: new URLSearchParams(String(init?.body)), type: headers["content-type"], auth: headers.authorization, redirect: init?.redirect };
    calls.push(call);
    return new Response(JSON.stringify(reply(call, calls.length)));
  }) as unknown as typeof fetch;
  return { fn, calls };
};

const user = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id.toLowerCase(), real_name: `Real ${id}`, profile: { display_name: "" }, ...over });

describe("usersList", () => {
  test("keeps people only and labels them by display name, then real name", async () => {
    const { fn, calls } = stub(() => ({
      ok: true,
      members: [
        user("U1", { profile: { display_name: "Alice" } }),
        user("U2", { name: "bob" }),
        user("U3", { deleted: true }),
        user("U4", { is_bot: true }),
        user("U5", { is_app_user: true }),
        user("USLACKBOT"),
      ],
    }));
    const directory = await createSlackBotClient({ token: TOKEN, fetch: fn }).usersList();
    expect(directory).toEqual({
      items: [
        { id: "U1", label: "Alice", detail: "@u1" },
        { id: "U2", label: "Real U2", detail: "@bob" },
      ],
      truncated: false,
    });
    expect(calls[0]!.url).toBe("https://slack.com/api/users.list");
    expect(calls[0]!.type).toBe("application/x-www-form-urlencoded");
    expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.redirect).toBe("error");
    expect(calls[0]!.params.get("limit")).toBe("200");
  });

  test("follows the cursor across pages", async () => {
    const { fn, calls } = stub((call) =>
      call.params.get("cursor") === "next"
        ? { ok: true, members: [user("U2")] }
        : { ok: true, members: [user("U1")], response_metadata: { next_cursor: "next" } },
    );
    const directory = await createSlackBotClient({ token: TOKEN, fetch: fn }).usersList();
    expect(directory.items.map((i) => i.id)).toEqual(["U1", "U2"]);
    expect(directory.truncated).toBe(false);
    expect(calls).toHaveLength(2);
  });

  test("stops after five pages and says the list is truncated", async () => {
    const { fn, calls } = stub((_, n) => ({ ok: true, members: [user(`U${n}`)], response_metadata: { next_cursor: `c${n}` } }));
    const directory = await createSlackBotClient({ token: TOKEN, fetch: fn }).usersList();
    expect(calls).toHaveLength(5);
    expect(directory.items).toHaveLength(5);
    expect(directory.truncated).toBe(true);
  });

  test("a Slack error keeps its code and never carries the token", async () => {
    const echo = stub(() => ({ ok: false, error: `missing_scope ${TOKEN}` }));
    const err = await createSlackBotClient({ token: TOKEN, fetch: echo.fn }).usersList().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackApiError);
    expect((err as SlackApiError).message).not.toContain(TOKEN);
    const plain = stub(() => ({ ok: false, error: "missing_scope" }));
    const coded = await createSlackBotClient({ token: TOKEN, fetch: plain.fn }).usersList().catch((e: unknown) => e);
    expect((coded as SlackApiError).code).toBe("missing_scope");
  });

  test("a transport failure that echoes the token is scrubbed", async () => {
    const fn = (async () => {
      throw new Error(`connect failed for ${TOKEN}`);
    }) as unknown as typeof fetch;
    const err = (await createSlackBotClient({ token: TOKEN, fetch: fn }).usersList().catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("Slack users.list failed");
    expect(err.message).not.toContain(TOKEN);
  });

  test("a body of the wrong shape is an error, not an empty list", async () => {
    const { fn } = stub(() => ({ ok: true, members: "nope" }));
    await expect(createSlackBotClient({ token: TOKEN, fetch: fn }).usersList()).rejects.toThrow("unexpected response");
  });
});

describe("channelsList", () => {
  test("asks for public and private channels without archived ones and flags where the bot is not a member", async () => {
    const { fn, calls } = stub((call) =>
      call.url.endsWith("users.conversations")
        ? { ok: true, channels: [] }
        : {
            ok: true,
            channels: [
              { id: "C1", name: "general", is_member: true },
              { id: "G2", name: "secret", is_member: false },
              { id: "C3", name: "old", is_member: true, is_archived: true },
            ],
          },
    );
    const directory = await createSlackBotClient({ token: TOKEN, fetch: fn }).channelsList();
    expect(directory.items).toEqual([
      { id: "C1", label: "#general", member: true },
      { id: "G2", label: "#secret", member: false },
    ]);
    expect(calls.map((c) => c.url)).toEqual(["https://slack.com/api/users.conversations", "https://slack.com/api/conversations.list"]);
    for (const call of calls) {
      expect(call.params.get("types")).toBe("public_channel,private_channel");
      expect(call.params.get("exclude_archived")).toBe("true");
      expect(call.params.get("limit")).toBe("200");
    }
  });

  test("lists the bot's own channels first, private ones included, even past the conversations.list cap", async () => {
    const { fn } = stub((call, n) =>
      call.url.endsWith("users.conversations")
        ? { ok: true, channels: [{ id: "G9", name: "private-team" }, { id: "C1", name: "general" }] }
        : { ok: true, channels: [{ id: "C1", name: "general", is_member: true }, { id: `C${n + 100}`, name: `c${n}` }], response_metadata: { next_cursor: "more" } },
    );
    const directory = await createSlackBotClient({ token: TOKEN, fetch: fn }).channelsList();
    expect(directory.items.slice(0, 3)).toEqual([
      { id: "G9", label: "#private-team", member: true },
      { id: "C1", label: "#general", member: true },
      { id: "C102", label: "#c2", member: false },
    ]);
    expect(directory.items.filter((i) => i.id === "C1")).toHaveLength(1);
    expect(directory.truncated).toBe(true);
  });

  test("caps the pages the same way", async () => {
    const { fn, calls } = stub((_, n) => ({ ok: true, channels: [{ id: `C${n}`, name: `c${n}` }], response_metadata: { next_cursor: "more" } }));
    const directory = await createSlackBotClient({ token: TOKEN, fetch: fn }).channelsList();
    expect(calls).toHaveLength(10);
    expect(directory.truncated).toBe(true);
  });
});

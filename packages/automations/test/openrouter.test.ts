import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { createOpenRouterClient } from "../src/openrouter";
import { json, mockFetch } from "./github.test";

const KEY = "sk-or-v1-SUPERSECRET";
const schema = z.object({ answer: z.enum(["yes", "no"]) });
const ask = (f: typeof fetch) =>
  createOpenRouterClient({ apiKey: KEY, fetch: f }).structured({ model: "m/one", system: "s", user: "u", name: "verdict", schema });
const reply = (content: string) => json(200, { choices: [{ message: { content } }] });

describe("openrouter client", () => {
  test("asks for strict JSON schema output and parses the answer", async () => {
    const { fn, calls } = mockFetch(() => reply('{"answer":"yes"}'));
    expect(await ask(fn)).toEqual({ answer: "yes" });
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0]?.headers).toMatchObject({ Authorization: `Bearer ${KEY}`, "X-Title": "automation-server" });
    expect(calls[0]?.body).toMatchObject({
      model: "m/one",
      provider: { require_parameters: true },
      response_format: {
        type: "json_schema",
        json_schema: { name: "verdict", strict: true, schema: { type: "object", required: ["answer"], additionalProperties: false } },
      },
    });
  });

  test("sends no sampling parameters, which newer models reject", async () => {
    const { fn, calls } = mockFetch(() => reply('{"answer":"yes"}'));
    await ask(fn);
    expect(calls[0]?.body).not.toHaveProperty("temperature");
  });

  test("invalid JSON and off-schema answers throw", async () => {
    await expect(ask(mockFetch(() => reply("sure!")).fn)).rejects.toThrow("returned no valid JSON");
    await expect(ask(mockFetch(() => reply('{"answer":"maybe"}')).fn)).rejects.toThrow("does not match the schema");
  });

  test("an API error names the status and never the key", async () => {
    const err = (await ask(mockFetch(() => json(401, { error: { message: `bad key ${KEY}` } })).fn).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("status 401");
    expect(err.message).not.toContain(KEY);
  });

  test("key() reads the key's label and usage", async () => {
    const { fn, calls } = mockFetch(() => json(200, { data: { label: "prod", limit: null, usage: 1.5 } }));
    expect(await createOpenRouterClient({ apiKey: KEY, fetch: fn }).key()).toEqual({ label: "prod", limit: null, usage: 1.5, expiresAt: null });
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/key");
  });

  test("requests never follow a redirect, so the bearer key cannot be forwarded", async () => {
    const seen: RequestInit["redirect"][] = [];
    const fn = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.redirect);
      return json(200, { data: { label: "prod", limit: null, usage: 1.5 } });
    }) as unknown as typeof fetch;
    await createOpenRouterClient({ apiKey: KEY, fetch: fn }).key();
    expect(seen).toEqual(["error"]);
  });
});

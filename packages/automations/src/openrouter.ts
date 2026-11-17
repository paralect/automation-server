import { z } from "zod";

import { redactText } from "./redact";

const API = "https://openrouter.ai/api/v1";
const TIMEOUT_MS = 90_000;

export type OpenRouterConfig = {
  apiKey: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
};

export class OpenRouterError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
  }
}

export type StructuredRequest<T> = {
  model: string;
  system: string;
  user: string;
  name: string;
  schema: z.ZodType<T>;
};

const completion = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({ message: z.object({ content: z.string().nullish() }) })).min(1),
});
const errorBody = z.object({ error: z.object({ message: z.string().optional() }).optional() });
const keyInfo = z.object({
  data: z.object({ label: z.string().nullish(), limit: z.number().nullish(), usage: z.number().nullish() }),
});

export type OpenRouterClient = ReturnType<typeof createOpenRouterClient>;

export function createOpenRouterClient(config: OpenRouterConfig) {
  const base = (config.apiBaseUrl ?? API).replace(/\/+$/, "");
  const doFetch = config.fetch ?? fetch;

  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "X-Title": "automation-server",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new Error(`OpenRouter ${method} ${path} failed: network error`);
    }
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const parsed = errorBody.safeParse(json);
      const detail = parsed.success ? (parsed.data.error?.message ?? "") : "";
      const safe = redactText(detail.split(config.apiKey).join("[redacted]")).slice(0, 300);
      throw new OpenRouterError(`OpenRouter ${method} ${path} failed with status ${res.status}${safe ? `: ${safe}` : ""}`, res.status);
    }
    return json;
  }

  return {
    async structured<T>(request: StructuredRequest<T>): Promise<T> {
      const { $schema: _, ...schema } = z.toJSONSchema(request.schema) as Record<string, unknown>;
      const json = await call("POST", "/chat/completions", {
        model: request.model,
        // No temperature: newer models (Claude 5.x) do not accept it, and require_parameters then finds no provider.
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        response_format: { type: "json_schema", json_schema: { name: request.name, strict: true, schema } },
        provider: { require_parameters: true },
      });
      const content = completion.parse(json).choices[0]?.message.content ?? "";
      let value: unknown;
      try {
        value = JSON.parse(content);
      } catch {
        throw new Error(`${request.model} returned no valid JSON for ${request.name}`);
      }
      const parsed = request.schema.safeParse(value);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join("; ");
        throw new Error(`${request.model} returned a ${request.name} that does not match the schema: ${issues.slice(0, 300)}`);
      }
      return parsed.data;
    },

    async key(): Promise<{ label: string | null; limit: number | null; usage: number | null }> {
      const { data } = keyInfo.parse(await call("GET", "/key"));
      return { label: data.label ?? null, limit: data.limit ?? null, usage: data.usage ?? null };
    },
  };
}

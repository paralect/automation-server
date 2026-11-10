import type { Dispatcher, Logger, Source } from "@automation-server/core";
import { Hono } from "hono";

export type WebhookDeps = {
  sources: Record<string, Source>;
  dispatcher: Dispatcher;
  log: Logger;
  maxBodyBytes?: number;
};

class BodyTooLargeError extends Error {}

async function readCapped(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function createWebhookRoutes({ sources, dispatcher, log, maxBodyBytes = 1_000_000 }: WebhookDeps) {
  const app = new Hono();

  app.post("/webhooks/:source", async (c) => {
    const name = c.req.param("source");
    const source = Object.hasOwn(sources, name) ? sources[name] : undefined;
    if (!source) return c.body(null, 404);

    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > maxBodyBytes) return c.body(null, 413);

    let rawBody: Uint8Array;
    try {
      rawBody = await readCapped(c.req.raw, maxBodyBytes);
    } catch (err) {
      if (err instanceof BodyTooLargeError) return c.body(null, 413);
      log.warn("webhook body read failed", { source: name });
      return c.body(null, 400);
    }

    const request = { headers: c.req.raw.headers, rawBody };
    if (!source.verify(request)) {
      log.warn("webhook signature rejected", { source: name });
      return c.body(null, 401);
    }

    let result: ReturnType<Source["parse"]>;
    try {
      result = source.parse(request, new Date());
    } catch {
      log.warn("webhook parse failed", { source: name });
      return c.body(null, 400);
    }

    if (result.type === "ignored") {
      log.info("webhook ignored", { source: name, reason: result.reason });
      return c.json({ ok: true });
    }

    const { kind, externalId } = result.event;
    log.info("webhook received", { source: name, kind, externalId });
    dispatcher.enqueue(result.event);
    return c.json({ ok: true });
  });

  return app;
}

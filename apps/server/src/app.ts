import { appRouter } from "@automation-server/api/routers/index";
import type { Dispatcher, Logger, Source } from "@automation-server/core";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { createContext, type AdminDeps } from "./context";
import { createWebhookRoutes } from "./webhooks";

export type AppDeps = {
  sources: () => Readonly<Record<string, Source>>;
  dispatcher: Dispatcher;
  log: Logger;
  corsOrigin?: string;
  maxBodyBytes?: number;
  admin: AdminDeps;
};

// These are answers the admin shows to the user, not server faults.
const EXPECTED_ERRORS = new Set(["UNAUTHORIZED", "NOT_FOUND", "BAD_REQUEST", "PRECONDITION_FAILED"]);

function logUnexpected(error: unknown) {
  if (error instanceof ORPCError && EXPECTED_ERRORS.has(error.code)) return;
  console.error(error);
}

export function createApp({ sources, dispatcher, log, corsOrigin, maxBodyBytes, admin }: AppDeps) {
  const app = new Hono();

  app.use(logger());
  app.use(
    "/*",
    cors({
      origin: corsOrigin ?? [],
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  );

  app.route("/", createWebhookRoutes({ sources, dispatcher, log, maxBodyBytes }));
  app.get("/health", (c) => c.json({ status: "ok" }));

  const apiHandler = new OpenAPIHandler(appRouter, {
    plugins: [
      new OpenAPIReferencePlugin({
        schemaConverters: [new ZodToJsonSchemaConverter()],
      }),
    ],
    interceptors: [
      onError(logUnexpected),
    ],
  });

  const rpcHandler = new RPCHandler(appRouter, {
    interceptors: [
      onError(logUnexpected),
    ],
  });

  app.use("/*", async (c, next) => {
    const context = await createContext({ context: c, ...admin });

    const rpcResult = await rpcHandler.handle(c.req.raw, {
      prefix: "/rpc",
      context: context,
    });

    if (rpcResult.matched) {
      return c.newResponse(rpcResult.response.body, rpcResult.response);
    }

    const apiResult = await apiHandler.handle(c.req.raw, {
      prefix: "/api-reference",
      context: context,
    });

    if (apiResult.matched) {
      return c.newResponse(apiResult.response.body, apiResult.response);
    }

    await next();
  });

  app.get("/", (c) => {
    return c.text("OK");
  });

  return app;
}

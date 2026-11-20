import { appRouter } from "@automation-server/api/routers/index";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { createContext } from "./context";
import { createWebhookRoutes } from "./webhooks";
// These are answers the admin shows to the user, not server faults.
const EXPECTED_ERRORS = new Set(["UNAUTHORIZED", "NOT_FOUND", "BAD_REQUEST", "PRECONDITION_FAILED"]);
function logUnexpected(error) {
    if (error instanceof ORPCError && EXPECTED_ERRORS.has(error.code))
        return;
    console.error(error);
}
export function createApp({ source, defaultProject, dispatcher, log, corsOrigin, maxBodyBytes, admin }) {
    const app = new Hono();
    app.use(logger());
    app.use("/*", cors({
        origin: corsOrigin ?? [],
        allowMethods: ["GET", "POST", "OPTIONS"],
    }));
    app.route("/", createWebhookRoutes({ source, defaultProject, dispatcher, log, maxBodyBytes }));
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
        const context = createContext({ context: c, ...admin });
        const rpcResult = await rpcHandler.handle(c.req.raw, {
            prefix: "/rpc",
            context,
        });
        if (rpcResult.matched) {
            return c.newResponse(rpcResult.response.body, rpcResult.response);
        }
        const apiResult = await apiHandler.handle(c.req.raw, {
            prefix: "/api-reference",
            context,
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

import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { env } from "./env.server";
let client;
function automationClient() {
    client ??= createORPCClient(new RPCLink({
        url: `${env().AUTOMATION_SERVER_URL.replace(/\/$/, "")}/rpc`,
        headers: { Authorization: `Bearer ${env().ADMIN_API_TOKEN}` },
        fetch: (request, init) => fetch(request, { ...init, signal: AbortSignal.timeout(10_000) }),
    }));
    return client;
}
function toApiError(error) {
    if (error instanceof ORPCError) {
        if (error.code === "UNAUTHORIZED" || error.code === "FORBIDDEN")
            return new Error("UNAUTHORIZED");
        // Other 4xx answers carry a message written for the operator, such as a rejected setting.
        if (error.status >= 400 && error.status < 500 && error.status !== 404 && error.message)
            return new Error(error.message);
        if (error.status >= 500 || error.code === "BAD_GATEWAY") {
            console.error("automation server error", error);
            return new Error("SERVER_ERROR");
        }
    }
    console.error("automation server unreachable", error);
    return new Error("UNREACHABLE");
}
export async function callAutomation(call, { notFoundIsExpected = false, showMessages = false } = {}) {
    const api = automationClient();
    try {
        return await call(api);
    }
    catch (error) {
        // Some routes word their NOT_FOUND and BAD_GATEWAY errors for the operator, such as a missing token permission.
        const shown = showMessages && error instanceof ORPCError && error.message;
        if (shown && error.code === "BAD_GATEWAY")
            throw new Error(error.message);
        if (error instanceof ORPCError && error.code === "NOT_FOUND") {
            // A wrong AUTOMATION_SERVER_URL also answers 404, so confirm the RPC endpoint is really there.
            try {
                await api.healthCheck();
            }
            catch (probe) {
                throw toApiError(probe);
            }
            if (notFoundIsExpected)
                throw new Error("NOT_FOUND");
            if (shown)
                throw new Error(error.message);
            console.error("automation server lacks this procedure; is it running an older version?", error);
            throw new Error("SERVER_ERROR");
        }
        throw toApiError(error);
    }
}

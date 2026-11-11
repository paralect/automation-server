import { createORPCClient, ORPCError } from "@orpc/client"
import { RPCLink } from "@orpc/client/fetch"
import type { AppRouterClient } from "@automation-server/api/routers/index"

import { env } from "./env.server"

export type ApiErrorCode = "UNAUTHORIZED" | "UNREACHABLE" | "NOT_FOUND" | "SERVER_ERROR"

let client: AppRouterClient | undefined

function automationClient() {
  client ??= createORPCClient<AppRouterClient>(
    new RPCLink({
      url: `${env().AUTOMATION_SERVER_URL.replace(/\/$/, "")}/rpc`,
      headers: { Authorization: `Bearer ${env().ADMIN_API_TOKEN}` },
      fetch: (request, init) =>
        fetch(request, { ...init, signal: AbortSignal.timeout(10_000) }),
    })
  )
  return client
}

function toApiError(error: unknown): Error {
  if (error instanceof ORPCError) {
    if (error.code === "UNAUTHORIZED" || error.code === "FORBIDDEN") return new Error("UNAUTHORIZED")
    // Other 4xx answers carry a message written for the operator, such as a rejected setting.
    if (error.status >= 400 && error.status < 500 && error.status !== 404 && error.message) return new Error(error.message)
    if (error.status >= 500 || error.code === "BAD_GATEWAY") {
      console.error("automation server error", error)
      return new Error("SERVER_ERROR")
    }
  }
  console.error("automation server unreachable", error)
  return new Error("UNREACHABLE")
}

export async function callAutomation<T>(
  call: (api: AppRouterClient) => Promise<T>,
  { notFoundIsExpected = false } = {}
): Promise<T> {
  const api = automationClient()
  try {
    return await call(api)
  } catch (error) {
    if (error instanceof ORPCError && error.code === "NOT_FOUND") {
      // A wrong AUTOMATION_SERVER_URL also answers 404, so confirm the RPC endpoint is really there.
      try {
        await api.healthCheck()
      } catch (probe) {
        throw toApiError(probe)
      }
      if (notFoundIsExpected) throw new Error("NOT_FOUND")
      console.error("automation server lacks this procedure; is it running an older version?", error)
      throw new Error("SERVER_ERROR")
    }
    throw toApiError(error)
  }
}

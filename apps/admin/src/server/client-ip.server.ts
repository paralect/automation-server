export function resolveClientIp(input: {
  forwardedFor: string | null
  socketIp: string | null
  trustProxy: boolean
}) {
  if (input.trustProxy && input.forwardedFor) {
    // The last entry is the one our own proxy appended; earlier ones are client-controlled.
    const last = input.forwardedFor.split(",").at(-1)?.trim()
    if (last) return last
  }
  return input.socketIp ?? "unknown"
}

export const CLIENT_IP_HEADER = "x-admin-client-ip"

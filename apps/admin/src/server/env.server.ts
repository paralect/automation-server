import { z } from "zod"

const schema = z.object({
  AUTOMATION_SERVER_URL: z.url(),
  ADMIN_API_TOKEN: z.string().min(1),
  ADMIN_EMAIL: z.email(),
  ADMIN_PASSWORD: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  TRUST_PROXY: z.stringbool().default(false),
})

let cached: z.infer<typeof schema> | undefined

export function parseEnv(source: Record<string, string | undefined>) {
  const parsed = schema.safeParse(source)
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `  ${issue.path.join(".")}: ${issue.message}`
    )
    throw new Error(
      `Invalid admin environment. Fix these variables (see apps/admin/.env.example):\n${lines.join("\n")}`
    )
  }
  return parsed.data
}

export function env() {
  cached ??= parseEnv(process.env)
  return cached
}

import { z } from "zod"

const schema = z.object({
  AUTOMATION_SERVER_URL: z.url(),
  ADMIN_API_TOKEN: z.string().min(1),
  ADMIN_EMAIL: z.string().min(1),
  ADMIN_PASSWORD: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
})

let cached: z.infer<typeof schema> | undefined

export function env() {
  if (cached) return cached
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `  ${issue.path.join(".")}: ${issue.message}`
    )
    throw new Error(
      `Invalid admin environment. Fix these variables (see apps/admin/.env.example):\n${lines.join("\n")}`
    )
  }
  cached = parsed.data
  return cached
}

import { z } from "zod";

export const GITHUB_API = "https://api.github.com";

export const githubHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "automation-server",
});

const ghError = z.object({ message: z.string().optional() });

export async function githubErrorDetail(res: Response): Promise<string> {
  const parsed = ghError.safeParse(await res.json().catch(() => null));
  return parsed.success && parsed.data.message ? parsed.data.message.slice(0, 200) : "";
}

import { z } from "zod";

export type GithubClientConfig = {
  repo: { owner: string; name: string };
  token: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
};

export type GithubLabel = { name: string; color?: string; description?: string };
export type CreatedIssue = { number: number; html_url: string };

const searchResponse = z.object({
  items: z.array(z.object({ html_url: z.string(), body: z.string().nullish() })),
});
const createdIssue = z.object({ number: z.number(), html_url: z.string() });
const errorBody = z.object({ errors: z.array(z.object({ code: z.string().optional() })).optional() });

export type GithubClient = ReturnType<typeof createGithubClient>;

export function createGithubClient(config: GithubClientConfig) {
  const base = (config.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const doFetch = config.fetch ?? fetch;
  const { owner, name } = config.repo;
  const repoPath = `/repos/${owner}/${name}`;

  async function request(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
    const endpoint = `${method} ${path.split("?")[0]}`;
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "automation-server",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error(`GitHub API ${endpoint} failed: network error`);
    }
    return res;
  }

  const fail = (method: string, path: string, res: Response): Error =>
    new Error(`GitHub API ${method} ${path.split("?")[0]} failed with status ${res.status}`);

  async function ensureLabel(label: GithubLabel): Promise<void> {
    const path = `${repoPath}/labels`;
    const res = await request("POST", path, label);
    if (res.ok) return;
    if (res.status === 422) {
      const parsed = errorBody.safeParse(await res.json().catch(() => null));
      if (parsed.success && parsed.data.errors?.some((e) => e.code === "already_exists")) return;
    }
    throw fail("POST", path, res);
  }

  return {
    async ensureLabels(labels: readonly (string | GithubLabel)[]): Promise<void> {
      for (const l of labels) await ensureLabel(typeof l === "string" ? { name: l } : l);
    },

    async findOpenIssueBySentryId(issueId: string): Promise<string | null> {
      const marker = `Sentry Issue: ${issueId}`;
      const q = `repo:${owner}/${name} is:issue is:open in:body "${marker}"`;
      const path = `/search/issues?q=${encodeURIComponent(q)}`;
      const res = await request("GET", path);
      if (!res.ok) throw fail("GET", path, res);
      const { items } = searchResponse.parse(await res.json());
      // Search tokenizes loosely and matches substrings like ids sharing a prefix, so confirm the exact marker line.
      const hit = items.find((i) => (i.body ?? "").split(/\r?\n/).some((line) => line.trim() === marker));
      return hit?.html_url ?? null;
    },

    async createIssue(issue: { title: string; body: string; labels: string[] }): Promise<CreatedIssue> {
      const path = `${repoPath}/issues`;
      const res = await request("POST", path, issue);
      if (!res.ok) throw fail("POST", path, res);
      return createdIssue.parse(await res.json());
    },
  };
}

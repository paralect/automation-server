import { z } from "zod";

import { redactText } from "./redact";

export type GithubClientConfig = {
  repo: { owner: string; name: string };
  token: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
};

export type GithubLabel = { name: string; color?: string; description?: string };
export type CreatedIssue = { number: number; html_url: string };

const issueList = z.array(
  z.object({ html_url: z.string(), body: z.string().nullish(), pull_request: z.unknown().optional() }),
);
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const createdIssue = z.object({ number: z.number(), html_url: z.string() });
const errorBody = z.object({
  message: z.string().optional(),
  errors: z.array(z.object({ code: z.string().optional(), message: z.string().optional() })).optional(),
});

const repoInfo = z.object({ default_branch: z.string() });

export class GithubApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GithubApiError";
    this.status = status;
  }
}

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

  // GitHub's own error text (never our request body or token) is what tells a permissions problem from a bad query.
  async function fail(method: string, path: string, res: Response): Promise<GithubApiError> {
    const parsed = errorBody.safeParse(await res.json().catch(() => null));
    const detail = parsed.success
      ? [parsed.data.message, ...(parsed.data.errors ?? []).map((e) => e.message)].filter(Boolean).join("; ")
      : "";
    const safe = redactText(detail.split(config.token).join("[redacted]")).slice(0, 300);
    return new GithubApiError(
      `GitHub API ${method} ${path.split("?")[0]} failed with status ${res.status}${safe ? `: ${safe}` : ""}`,
      res.status,
    );
  }

  async function ensureLabel(label: GithubLabel): Promise<void> {
    const path = `${repoPath}/labels`;
    const res = await request("POST", path, label);
    if (res.ok) return;
    if (res.status === 422) {
      const parsed = errorBody.safeParse(await res.json().catch(() => null));
      if (parsed.success && parsed.data.errors?.some((e) => e.code === "already_exists")) return;
    }
    throw await fail("POST", path, res);
  }

  return {
    async ensureLabels(labels: readonly (string | GithubLabel)[]): Promise<void> {
      for (const l of labels) await ensureLabel(typeof l === "string" ? { name: l } : l);
    },

    // Lists open `sentry` issues instead of using search: search is rate limited, lags behind new issues, and
    // is rejected for some fine-grained tokens that can otherwise read the repo.
    async findOpenIssueBySentryId(issueId: string): Promise<string | null> {
      const marker = `Sentry Issue: ${issueId}`;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const path = `${repoPath}/issues?state=open&labels=sentry&per_page=${PAGE_SIZE}&page=${page}`;
        const res = await request("GET", path);
        if (!res.ok) throw await fail("GET", path, res);
        const items = issueList.parse(await res.json());
        const hit = items.find(
          (i) => !i.pull_request && (i.body ?? "").split(/\r?\n/).some((line) => line.trim() === marker),
        );
        if (hit) return hit.html_url;
        if (items.length < PAGE_SIZE) break;
      }
      return null;
    },

    async createIssue(issue: { title: string; body: string; labels: string[] }): Promise<CreatedIssue> {
      const path = `${repoPath}/issues`;
      const res = await request("POST", path, issue);
      if (!res.ok) throw await fail("POST", path, res);
      return createdIssue.parse(await res.json());
    },

    async defaultBranch(): Promise<string> {
      const res = await request("GET", repoPath);
      if (!res.ok) throw await fail("GET", repoPath, res);
      return repoInfo.parse(await res.json()).default_branch;
    },

    async dispatchWorkflow(workflowFile: string, ref: string, inputs: Readonly<Record<string, string>>): Promise<void> {
      const path = `${repoPath}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`;
      const res = await request("POST", path, { ref, inputs });
      if (!res.ok) throw await fail("POST", path, res);
    },
  };
}

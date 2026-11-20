import type { Observer } from "@automation-server/ledger";
import { z } from "zod";

import { redactUntrusted } from "./redact";

export type GithubClientConfig = {
  repo: { owner: string; name: string };
  token: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  // Required so every builder decides: the project's observer, or UNOBSERVED on purpose.
  observe: Observer;
};

export type GithubLabel = { name: string; color?: string; description?: string };
export type CreatedIssue = { number: number; html_url: string };

export type GithubIssueSummary = {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly url: string;
  readonly labels: readonly string[];
  readonly isPullRequest: boolean;
};

export type GithubIssueDetail = GithubIssueSummary & { readonly body: string; readonly author: string | null; readonly comments: number };

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

const labelNames = z.array(z.union([z.string(), z.object({ name: z.string() })])).optional();
const issueSummary = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  html_url: z.string(),
  labels: labelNames,
  pull_request: z.unknown().optional(),
});
const searchResult = z.object({ items: z.array(issueSummary) });
const issueDetail = issueSummary.extend({
  body: z.string().nullish(),
  user: z.object({ login: z.string() }).nullish(),
  comments: z.number().optional(),
});

const toSummary = (i: z.infer<typeof issueSummary>): GithubIssueSummary => ({
  number: i.number,
  title: i.title,
  state: i.state,
  url: i.html_url,
  labels: (i.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)),
  isPullRequest: i.pull_request !== undefined,
});

// The model writes the query, and a repo: qualifier in it would search outside the configured repository.
const SCOPE_QUALIFIER = /\b(?:repo|org|user|owner|enterprise):\S*/gi;

const repoInfo = z.object({ default_branch: z.string() });
const runDetails = z.object({ workflow_run_id: z.number().int().positive() });

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

  async function fail(method: string, path: string, res: Response): Promise<GithubApiError> {
    const parsed = errorBody.safeParse(await res.json().catch(() => null));
    const detail = parsed.success
      ? [parsed.data.message, ...(parsed.data.errors ?? []).map((e) => e.message)].filter(Boolean).join("; ")
      : "";
    const safe = redactUntrusted(detail.split(config.token).join("[redacted]")).slice(0, 300);
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

    // Lists open issues by label instead of using search: search is rate limited, lags behind new issues, and
    // is rejected for some fine-grained tokens that can otherwise read the repo.
    async findOpenIssueByMarker(label: string, marker: string): Promise<string | null> {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const path = `${repoPath}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=${PAGE_SIZE}&page=${page}`;
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
      const created = createdIssue.parse(await res.json());
      config.observe.github({ kind: "issue_created", repo: `${owner}/${name}`, number: created.number, url: created.html_url });
      return created;
    },

    async searchIssues(query: string, limit: number): Promise<GithubIssueSummary[]> {
      const terms = query.replace(SCOPE_QUALIFIER, " ").replace(/\s+/g, " ").trim();
      const q = `${terms} repo:${owner}/${name} is:issue`;
      const path = `/search/issues?q=${encodeURIComponent(q)}&per_page=${limit}`;
      const res = await request("GET", path);
      if (!res.ok) throw await fail("GET", path, res);
      return searchResult.parse(await res.json()).items.map(toSummary);
    },

    async getIssue(number: number): Promise<GithubIssueDetail | null> {
      const path = `${repoPath}/issues/${number}`;
      const res = await request("GET", path);
      if (res.status === 404) return null;
      if (!res.ok) throw await fail("GET", path, res);
      const issue = issueDetail.parse(await res.json());
      return { ...toSummary(issue), body: issue.body ?? "", author: issue.user?.login ?? null, comments: issue.comments ?? 0 };
    },

    async defaultBranch(): Promise<string> {
      const res = await request("GET", repoPath);
      if (!res.ok) throw await fail("GET", repoPath, res);
      return repoInfo.parse(await res.json()).default_branch;
    },

    async dispatchWorkflow(workflowFile: string, ref: string, inputs: Readonly<Record<string, string>>): Promise<void> {
      const path = `${repoPath}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`;
      // With return_run_details GitHub answers 200 with the new run's id instead of a bare 204, so the run links to this dispatch exactly.
      let res = await request("POST", path, { ref, inputs, return_run_details: true });
      // GitHub Enterprise Server before 3.21 rejects the unknown field with 422. A real 422 (no workflow_dispatch trigger, unknown ref) fails the same way again.
      if (res.status === 422) res = await request("POST", path, { ref, inputs });
      if (!res.ok) throw await fail("POST", path, res);
      const details = res.status === 200 ? runDetails.safeParse(await res.json().catch(() => null)) : null;
      config.observe.github({
        kind: "workflow_dispatched",
        repo: `${owner}/${name}`,
        workflowFile,
        ref,
        inputs,
        workflowRunId: details?.success ? details.data.workflow_run_id : null,
      });
    },
  };
}

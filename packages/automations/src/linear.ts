import { z } from "zod";

import { scrub } from "./posthogWeeklyReport/scrub";

export const LINEAR_API = "https://api.linear.app/graphql";
const TIMEOUT_MS = 10_000;
const MAX_COMMENTS = 5;

export type LinearClientConfig = {
  apiKey: string;
  apiUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type LinearIssueSummary = {
  readonly identifier: string;
  readonly title: string;
  readonly url: string;
  readonly state: string | null;
  readonly assignee: string | null;
};

export type LinearIssue = LinearIssueSummary & {
  readonly description: string;
  readonly labels: readonly string[];
  readonly comments: readonly { readonly author: string | null; readonly body: string }[];
};

export type LinearClient = {
  viewer(): Promise<{ readonly name: string; readonly organization: string | null }>;
  searchIssues(term: string, limit: number): Promise<readonly LinearIssueSummary[]>;
  getIssue(identifier: string): Promise<LinearIssue | null>;
};

export class LinearApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinearApiError";
  }
}

const named = z.object({ name: z.string() }).nullish();
const summary = z.object({
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  state: named,
  assignee: named,
});
const envelope = z.object({ data: z.unknown().nullish(), errors: z.array(z.object({ message: z.string().optional() })).optional() });
const viewerData = z.object({ viewer: z.object({ name: z.string() }), organization: z.object({ name: z.string() }).nullish() });
const searchData = z.object({ searchIssues: z.object({ nodes: z.array(summary) }) });
const issueData = z.object({
  issue: summary
    .extend({
      description: z.string().nullish(),
      labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }).nullish(),
      comments: z.object({ nodes: z.array(z.object({ body: z.string(), user: named })) }).nullish(),
    })
    .nullable(),
});

const toSummary = (issue: z.infer<typeof summary>): LinearIssueSummary => ({
  identifier: issue.identifier,
  title: issue.title,
  url: issue.url,
  state: issue.state?.name ?? null,
  assignee: issue.assignee?.name ?? null,
});

const SUMMARY_FIELDS = "identifier title url state { name } assignee { name }";

export function createLinearClient({ apiKey, apiUrl = LINEAR_API, fetch: doFetch = fetch, timeoutMs = TIMEOUT_MS }: LinearClientConfig): LinearClient {
  const fail = (what: string): never => {
    throw new LinearApiError(`Linear request failed: ${scrub(what, [apiKey])}`);
  };

  const query = async <T>(document: string, variables: Record<string, unknown>, shape: z.ZodType<T>): Promise<T> => {
    let res: Response;
    try {
      res = await doFetch(apiUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: apiKey },
        body: JSON.stringify({ query: document, variables }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch (err) {
      return fail(err instanceof Error && err.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : "network error");
    }
    if (res.status === 401 || res.status === 403) return fail(`HTTP ${res.status}, the API key was rejected`);
    const body = envelope.safeParse(await res.json().catch(() => null));
    if (!body.success) return fail(`HTTP ${res.status}`);
    const { errors, data } = body.data;
    if (errors && errors.length > 0) return fail(errors.map((e) => e.message ?? "error").join("; "));
    if (!res.ok) return fail(`HTTP ${res.status}`);
    const parsed = shape.safeParse(data);
    return parsed.success ? parsed.data : fail("unexpected response");
  };

  return {
    async viewer() {
      const { viewer, organization } = await query("query { viewer { name } organization { name } }", {}, viewerData);
      return { name: viewer.name, organization: organization?.name ?? null };
    },
    async searchIssues(term, limit) {
      const { searchIssues } = await query(
        `query($term: String!, $first: Int!) { searchIssues(term: $term, first: $first) { nodes { ${SUMMARY_FIELDS} } } }`,
        { term, first: limit },
        searchData,
      );
      return searchIssues.nodes.map(toSummary);
    },
    async getIssue(identifier) {
      const { issue } = await query(
        `query($id: String!) { issue(id: $id) { ${SUMMARY_FIELDS} description labels { nodes { name } } comments(first: ${MAX_COMMENTS}) { nodes { body user { name } } } } }`,
        { id: identifier },
        issueData,
      );
      if (!issue) return null;
      return {
        ...toSummary(issue),
        description: issue.description ?? "",
        labels: (issue.labels?.nodes ?? []).map((l) => l.name),
        comments: (issue.comments?.nodes ?? []).map((c) => ({ author: c.user?.name ?? null, body: c.body })),
      };
    },
  };
}

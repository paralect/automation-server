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
  createIssue(input: NewLinearIssue): Promise<LinearIssueSummary>;
  addLabel(identifier: string, label: string): Promise<LinearIssueSummary>;
};

export type NewLinearIssue = {
  readonly title: string;
  readonly description?: string;
  readonly teamKey?: string;
  readonly labels?: readonly string[];
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

const teamsData = z.object({ teams: z.object({ nodes: z.array(z.object({ id: z.string(), key: z.string() })) }) });
const labelsData = z.object({
  issueLabels: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string(), team: z.object({ key: z.string() }).nullish() })) }),
});
const issueRefData = z.object({ issue: z.object({ id: z.string(), team: z.object({ key: z.string() }).nullish() }).nullable() });
const createData = z.object({ issueCreate: z.object({ success: z.boolean(), issue: summary.nullable() }) });
const addLabelData = z.object({ issueAddLabel: z.object({ success: z.boolean(), issue: summary.nullable() }) });

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

  const sameKey = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  // A label is never created here: a name that does not exist is an error, so a typo cannot add a label to the workspace.
  const findLabel = async (name: string, teamKey: string | null): Promise<{ id: string; name: string }> => {
    const { issueLabels } = await query(
      "query($name: String!) { issueLabels(first: 25, filter: { name: { eqIgnoreCase: $name } }) { nodes { id name team { key } } } }",
      { name },
      labelsData,
    );
    const usable = issueLabels.nodes.filter((l) => !l.team || teamKey === null || sameKey(l.team.key, teamKey));
    const label = usable.find((l) => l.team) ?? usable[0];
    return label ?? fail(`label "${name}" does not exist${teamKey ? ` for team ${teamKey}` : ""}, and labels are never created automatically`);
  };

  const resolveTeam = async (teamKey: string | undefined): Promise<{ id: string; key: string }> => {
    const { teams } = await query("query { teams(first: 50) { nodes { id key } } }", {}, teamsData);
    if (teamKey) return teams.nodes.find((t) => sameKey(t.key, teamKey)) ?? fail(`team ${teamKey} does not exist. Teams: ${teams.nodes.map((t) => t.key).join(", ") || "none"}`);
    const [only, ...rest] = teams.nodes;
    if (only && rest.length === 0) return only;
    return fail(`teamKey is required. Teams: ${teams.nodes.map((t) => t.key).join(", ") || "none"}`);
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
    async createIssue({ title, description, teamKey, labels = [] }) {
      const team = await resolveTeam(teamKey);
      const labelIds: string[] = [];
      for (const name of labels) labelIds.push((await findLabel(name, team.key)).id);
      const { issueCreate } = await query(
        `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${SUMMARY_FIELDS} } } }`,
        { input: { teamId: team.id, title, ...(description ? { description } : {}), ...(labelIds.length > 0 ? { labelIds } : {}) } },
        createData,
      );
      if (!issueCreate.success || !issueCreate.issue) return fail("Linear did not create the issue");
      return toSummary(issueCreate.issue);
    },
    async addLabel(identifier, labelName) {
      const { issue } = await query("query($id: String!) { issue(id: $id) { id team { key } } }", { id: identifier }, issueRefData);
      if (!issue) return fail(`issue ${identifier} was not found`);
      const label = await findLabel(labelName, issue.team?.key ?? null);
      const { issueAddLabel } = await query(
        `mutation($id: String!, $labelId: String!) { issueAddLabel(id: $id, labelId: $labelId) { success issue { ${SUMMARY_FIELDS} } } }`,
        { id: issue.id, labelId: label.id },
        addLabelData,
      );
      if (!issueAddLabel.success || !issueAddLabel.issue) return fail("Linear did not add the label");
      return toSummary(issueAddLabel.issue);
    },
  };
}

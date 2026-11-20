import type { RepoName, WorkKey, WorkRef } from "./types";

// Every rule that ties an issue, a dispatch, a workflow run and a PR to one unit of work lives in this file.

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LINEAR_ID = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const ISSUE_NUMBER = /^[1-9]\d{0,9}$/;

// GitHub repository names are case-insensitive, so the canonical form is lowercase and joins never miss on case.
export const isRepoName = (value: string): value is RepoName => REPO.test(value) && value === value.toLowerCase();

export function parseRepoName(value: string): RepoName | null {
  const lower = value.trim().toLowerCase();
  return isRepoName(lower) ? lower : null;
}

const isWorkKey = (value: string): value is WorkKey => parseRef(value) !== null;

function parseRef(key: string): WorkRef | null {
  const gh = /^gh:([^#]+)#(\d+)$/.exec(key);
  if (gh) {
    const [, repo = "", number = ""] = gh;
    return isRepoName(repo) && ISSUE_NUMBER.test(number) ? { kind: "github-issue", repo, number: Number(number) } : null;
  }
  const linear = /^linear:(.+)$/.exec(key);
  const identifier = linear?.[1] ?? "";
  return LINEAR_ID.test(identifier) && identifier === identifier.toUpperCase() ? { kind: "linear-issue", identifier } : null;
}

export function workKey(ref: WorkRef): WorkKey {
  const key = ref.kind === "github-issue" ? `gh:${ref.repo}#${ref.number}` : `linear:${ref.identifier.toUpperCase()}`;
  if (!isWorkKey(key)) throw new Error(`not a valid work item: ${key}`);
  return key;
}

// For keys read back from storage.
export function parseWorkKey(key: string): WorkRef | null {
  return parseRef(key);
}

const githubIssue = (repo: RepoName, number: string): WorkKey | null =>
  ISSUE_NUMBER.test(number) ? workKey({ kind: "github-issue", repo, number: Number(number) }) : null;

const linearIssue = (identifier: string): WorkKey | null =>
  LINEAR_ID.test(identifier) ? workKey({ kind: "linear-issue", identifier }) : null;

// codex-issue-fix takes issue_number, linear-implement takes issue_identifier. Other workflows name no work item.
export function workKeyFromDispatch(repo: RepoName, inputs: Readonly<Record<string, string>>): WorkKey | null {
  const identifier = inputs.issue_identifier?.trim();
  if (identifier) return linearIssue(identifier);
  const number = inputs.issue_number?.trim();
  return number ? githubIssue(repo, number) : null;
}

// The branch linear-implement.yml pushes: the identifier lowercased, anything outside [a-z0-9-] turned into "-".
const linearSlug = (identifier: string) => identifier.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+$/, "");

// The branch the workflow pushed, then the title linear-implement writes. Never an issue reference in the body: a changelog or
// SEO PR that quotes "closes #42" did not do the work of #42.
export function workKeyFromPullRequest(pr: { readonly repo: RepoName; readonly headBranch: string; readonly title: string }): WorkKey | null {
  const codex = /^codex\/issue-(\d+)$/.exec(pr.headBranch);
  if (codex) return githubIssue(pr.repo, codex[1] ?? "");
  const linear = /^linear\/(.+)$/.exec(pr.headBranch);
  if (linear) {
    const slug = linear[1] ?? "";
    const titled = /^([A-Za-z][A-Za-z0-9]*-\d+):/.exec(pr.title)?.[1];
    if (titled && linearSlug(titled) === slug) return linearIssue(titled);
    return linearIssue(slug);
  }
  return null;
}

// The run-name the templates set: "Codex issue fix #123" and "Linear implement ENG-42". Older installs have no run-name, so null.
export function workKeyFromRunTitle(repo: RepoName, title: string): WorkKey | null {
  const codex = /^Codex issue fix #(\d+)$/.exec(title.trim());
  if (codex) return githubIssue(repo, codex[1] ?? "");
  const linear = /^Linear implement (\S+)$/.exec(title.trim());
  return linear ? linearIssue(linear[1] ?? "") : null;
}

// "Run log: https://github.com/<repo>/actions/runs/<id>" at the end of a Codex PR body names the run that opened it. Only the
// last such line counts: the workflow appends it after the Codex summary, which can carry any text.
export function workflowRunIdFromBody(repo: RepoName, body: string): number | null {
  const last = [...body.matchAll(/Run log:\s*https?:\/\/\S+?\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/actions\/runs\/(\d+)/g)].at(-1);
  return last?.[1]?.toLowerCase() === repo ? Number(last[2]) : null;
}

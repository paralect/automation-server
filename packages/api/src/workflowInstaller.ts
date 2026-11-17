import { createHash } from "node:crypto";
import { z } from "zod";

import { GITHUB_API, githubErrorDetail, githubHeaders } from "./githubApi";
import { WORKFLOW_TEMPLATES, type TemplateFile, type WorkflowTemplate } from "./workflowTemplates";

export type PullRequestRef = { readonly number: number; readonly url: string };

export type TemplateState = "installed" | "differs" | "missing";

export type TemplateStatus = {
  readonly templateId: string;
  readonly state: TemplateState;
  readonly changedFiles: string[];
  readonly pullRequest: PullRequestRef | null;
};

export type WorkflowStatus = { readonly repo: string; readonly defaultBranch: string; readonly templates: TemplateStatus[] };

export type WorkflowCheck = { readonly repo: string; readonly defaultBranch: string; readonly template: TemplateStatus };

export type InstallMode = "pr" | "direct";

export type InstallOutcome =
  | "already-installed"
  | "committed"
  | "pr-opened"
  | "pr-exists";

export type InstallResult = {
  readonly repo: string;
  readonly templateId: string;
  readonly mode: InstallMode;
  readonly outcome: InstallOutcome;
  readonly branch: string;
  readonly filesWritten: string[];
  readonly pullRequest: PullRequestRef | null;
};

export type InstallRequest = { repo: string; templateId: string; mode: InstallMode };

export type WorkflowInstaller = {
  status(repo: string): Promise<WorkflowStatus>;
  check(repo: string, templateId: string): Promise<WorkflowCheck>;
  install(request: InstallRequest): Promise<InstallResult>;
};

export type WorkflowInstallErrorKind = "not-configured" | "unknown-template" | "github";

export class WorkflowInstallError extends Error {
  constructor(
    message: string,
    readonly kind: WorkflowInstallErrorKind,
  ) {
    super(message);
  }
}

export type WorkflowInstallerConfig = {
  token: string | undefined;
  templates?: readonly WorkflowTemplate[];
  apiBaseUrl?: string;
  fetch?: typeof fetch;
};

export const installBranch = (templateId: string) => `automation-server/install-${templateId}`;

export const gitBlobSha = (content: string) =>
  createHash("sha1").update(`blob ${Buffer.byteLength(content, "utf8")}\0`).update(content, "utf8").digest("hex");

const PERMISSIONS = "It needs Contents, Pull requests and Workflows read and write access on this repository.";

const ghRepo = z.object({ default_branch: z.string(), owner: z.object({ login: z.string() }) });
const ghContent = z.union([z.object({ sha: z.string() }), z.array(z.unknown())]);
const ghRef = z.object({ object: z.object({ sha: z.string() }) });
const ghPull = z.object({ number: z.number(), html_url: z.string() });

type FileCheck = { file: TemplateFile; sha: string | null; same: boolean };

export function createWorkflowInstaller(config: WorkflowInstallerConfig): WorkflowInstaller {
  const base = (config.apiBaseUrl ?? GITHUB_API).replace(/\/+$/, "");
  const doFetch = config.fetch ?? fetch;
  const templates = config.templates ?? WORKFLOW_TEMPLATES;

  function templateOf(id: string): WorkflowTemplate {
    const found = templates.find((t) => t.id === id);
    if (!found) throw new WorkflowInstallError(`Unknown workflow template "${id}"`, "unknown-template");
    return found;
  }

  async function call(
    method: string,
    path: string,
    action: string,
    options: { body?: unknown; missingOk?: boolean } = {},
  ): Promise<unknown> {
    if (!config.token) {
      throw new WorkflowInstallError("The GitHub token is not configured. Set it on the Integrations page.", "not-configured");
    }
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          ...githubHeaders(config.token),
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new WorkflowInstallError("GitHub API is unreachable", "github");
    }
    if (res.ok) return res.json();
    if (res.status === 404 && options.missingOk) return null;
    const detail = await githubErrorDetail(res);
    if (res.status === 401) throw new WorkflowInstallError("GitHub rejected the token. Replace it on the Integrations page.", "github");
    if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
      throw new WorkflowInstallError("GitHub API rate limit reached. Try again in a few minutes.", "github");
    }
    // GitHub answers 404 rather than 403 when a fine-grained token lacks access, so both mean missing permission here.
    if (res.status === 403 || res.status === 404) {
      throw new WorkflowInstallError(`The GitHub token cannot ${action}. ${PERMISSIONS}`, "github");
    }
    throw new WorkflowInstallError(`GitHub API answered ${res.status} while trying to ${action}${detail ? `: ${detail}` : ""}`, "github");
  }

  async function repoInfo(repo: string) {
    const found = await call("GET", `/repos/${repo}`, `read ${repo}`, { missingOk: true });
    if (found === null) {
      throw new WorkflowInstallError(
        `Repository ${repo} was not found, or the GitHub token cannot see it. Give the token access to it.`,
        "github",
      );
    }
    const parsed = ghRepo.parse(found);
    return { defaultBranch: parsed.default_branch, owner: parsed.owner.login };
  }

  const contentsPath = (repo: string, path: string) =>
    `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;

  async function checkFiles(repo: string, template: WorkflowTemplate, ref: string): Promise<FileCheck[]> {
    return Promise.all(
      template.files.map(async (file) => {
        const found = await call("GET", `${contentsPath(repo, file.path)}?ref=${encodeURIComponent(ref)}`, `read ${file.path} in ${repo}`, {
          missingOk: true,
        });
        if (found === null) return { file, sha: null, same: false };
        const parsed = ghContent.parse(found);
        // A directory at the file's path cannot be overwritten through the contents API, the PUT reports it.
        const sha = Array.isArray(parsed) ? null : parsed.sha;
        return { file, sha, same: sha === gitBlobSha(file.content) };
      }),
    );
  }

  async function openPullRequest(repo: string, owner: string, branch: string): Promise<PullRequestRef | null> {
    const params = new URLSearchParams({ state: "open", head: `${owner}:${branch}`, per_page: "1" });
    const found = z.array(ghPull).parse(await call("GET", `/repos/${repo}/pulls?${params}`, `list pull requests in ${repo}`));
    const first = found[0];
    return first ? { number: first.number, url: first.html_url } : null;
  }

  async function ensureBranch(repo: string, branch: string, from: string) {
    const existing = await call("GET", `/repos/${repo}/git/ref/heads/${branch}`, `read branches in ${repo}`, { missingOk: true });
    if (existing !== null) return;
    const head = ghRef.parse(await call("GET", `/repos/${repo}/git/ref/heads/${from}`, `read branch ${from} in ${repo}`));
    await call("POST", `/repos/${repo}/git/refs`, `create branch ${branch} in ${repo}`, {
      body: { ref: `refs/heads/${branch}`, sha: head.object.sha },
    });
  }

  async function writeFiles(repo: string, template: WorkflowTemplate, branch: string, checks: FileCheck[]): Promise<string[]> {
    const written: string[] = [];
    // One commit per file, sequential: parallel PUTs to one branch race on its head and fail with 409.
    for (const { file, sha } of checks.filter((c) => !c.same)) {
      await call("PUT", contentsPath(repo, file.path), `write ${file.path} in ${repo}`, {
        body: {
          message: `${sha ? "Update" : "Add"} ${file.path} (${template.title})`,
          content: Buffer.from(file.content, "utf8").toString("base64"),
          branch,
          ...(sha ? { sha } : {}),
        },
      });
      written.push(file.path);
    }
    return written;
  }

  const pullRequestBody = (template: WorkflowTemplate) =>
    [
      `Installs the **${template.title}** workflow from automation-server.`,
      "",
      template.description,
      "",
      "Files:",
      ...template.files.map((f) => `- \`${f.path}\``),
      ...(template.requiredSecrets.length > 0
        ? ["", "Repository secrets to add before it runs:", ...template.requiredSecrets.map((names) => `- ${names.map((n) => `\`${n}\``).join(" or ")}`)]
        : []),
      ...(template.requiredVariables.length > 0
        ? ["", "Repository variables to add:", ...template.requiredVariables.map((n) => `- \`${n}\``)]
        : []),
    ].join("\n");

  async function templateStatus(repo: string, owner: string, defaultBranch: string, template: WorkflowTemplate): Promise<TemplateStatus> {
    const [checks, pullRequest] = await Promise.all([
      checkFiles(repo, template, defaultBranch),
      openPullRequest(repo, owner, installBranch(template.id)),
    ]);
    const changedFiles = checks.filter((c) => !c.same).map((c) => c.file.path);
    const workflowPresent = checks[0]?.sha != null;
    const state: TemplateState = changedFiles.length === 0 ? "installed" : workflowPresent ? "differs" : "missing";
    return { templateId: template.id, state, changedFiles, pullRequest };
  }

  return {
    async status(repo) {
      const { defaultBranch, owner } = await repoInfo(repo);
      const statuses = await Promise.all(templates.map((template) => templateStatus(repo, owner, defaultBranch, template)));
      return { repo, defaultBranch, templates: statuses };
    },

    async check(repo, templateId) {
      const template = templateOf(templateId);
      const { defaultBranch, owner } = await repoInfo(repo);
      return { repo, defaultBranch, template: await templateStatus(repo, owner, defaultBranch, template) };
    },

    async install({ repo, templateId, mode }) {
      const template = templateOf(templateId);
      const { defaultBranch, owner } = await repoInfo(repo);
      const result = { repo, templateId, mode };
      const onDefault = await checkFiles(repo, template, defaultBranch);
      if (onDefault.every((c) => c.same)) {
        return { ...result, outcome: "already-installed", branch: defaultBranch, filesWritten: [], pullRequest: null };
      }

      if (mode === "direct") {
        const filesWritten = await writeFiles(repo, template, defaultBranch, onDefault);
        return { ...result, outcome: "committed", branch: defaultBranch, filesWritten, pullRequest: null };
      }

      const branch = installBranch(template.id);
      await ensureBranch(repo, branch, defaultBranch);
      const filesWritten = await writeFiles(repo, template, branch, await checkFiles(repo, template, branch));
      const existing = await openPullRequest(repo, owner, branch);
      if (existing) return { ...result, outcome: "pr-exists", branch, filesWritten, pullRequest: existing };

      const created = ghPull.parse(
        await call("POST", `/repos/${repo}/pulls`, `open a pull request in ${repo}`, {
          body: { title: `Install the ${template.title} workflow`, head: branch, base: defaultBranch, body: pullRequestBody(template) },
        }),
      );
      return { ...result, outcome: "pr-opened", branch, filesWritten, pullRequest: { number: created.number, url: created.html_url } };
    },
  };
}

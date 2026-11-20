import { describe, expect, test } from "bun:test";
import { createWorkflowInstaller, gitBlobSha, WorkflowInstallError } from "@automation-server/api/workflowInstaller";
import { buildTemplates } from "@automation-server/api/workflowTemplates";
const TOKEN = "ghp_installer_secret";
const BRANCH = "automation-server/install-demo";
const templatesWith = (workflow) => buildTemplates({ "demo.yml": workflow, "skills/demo/SKILL.md": "skill v1" }, { "demo.yml": { title: "Demo", description: "Demo workflow", skill: "demo", requiredSecrets: [["CODEX_AUTH_JSON"]], requiredVariables: ["SITE"] } });
const TEMPLATES = templatesWith("name: demo v1");
function fakeGithub(options = {}) {
    const branches = { main: {} };
    const pulls = [];
    const writes = [];
    const headers = [];
    const fetch = (async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const path = decodeURIComponent(url.pathname);
        headers.push(new Headers(init?.headers).get("authorization") ?? "");
        const denied = options.deny?.(method, path);
        if (denied)
            return Response.json({ message: "denied" }, { status: denied });
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (path === "/repos/acme/site")
            return Response.json({ default_branch: "main", owner: { login: "acme" } });
        const contents = /^\/repos\/acme\/site\/contents\/(.+)$/.exec(path);
        if (contents?.[1] && method === "GET") {
            const content = branches[url.searchParams.get("ref") ?? "main"]?.[contents[1]];
            return content === undefined ? Response.json({ message: "Not Found" }, { status: 404 }) : Response.json({ sha: gitBlobSha(content) });
        }
        if (contents?.[1] && method === "PUT") {
            const files = branches[body.branch];
            if (!files)
                return Response.json({ message: "No branch" }, { status: 404 });
            const current = files[contents[1]];
            if ((current === undefined) !== (body.sha === undefined) || (current !== undefined && gitBlobSha(current) !== body.sha)) {
                return Response.json({ message: "sha mismatch" }, { status: 409 });
            }
            files[contents[1]] = Buffer.from(body.content, "base64").toString("utf8");
            writes.push(`${body.branch}:${contents[1]}`);
            return Response.json({ content: {} }, { status: current === undefined ? 201 : 200 });
        }
        const ref = /^\/repos\/acme\/site\/git\/ref\/heads\/(.+)$/.exec(path);
        if (ref?.[1]) {
            return branches[ref[1]] ? Response.json({ object: { sha: `head-${ref[1]}` } }) : Response.json({ message: "Not Found" }, { status: 404 });
        }
        if (path === "/repos/acme/site/git/refs" && method === "POST") {
            branches[body.ref.replace("refs/heads/", "")] = { ...branches[body.sha.replace("head-", "")] };
            return Response.json({}, { status: 201 });
        }
        if (path === "/repos/acme/site/pulls" && method === "GET") {
            const head = url.searchParams.get("head");
            return Response.json(pulls.filter((p) => p.open && `acme:${p.head}` === head).map((p) => ({ number: p.number, html_url: `https://github.com/acme/site/pull/${p.number}` })));
        }
        if (path === "/repos/acme/site/pulls" && method === "POST") {
            const pull = { number: pulls.length + 1, head: body.head, base: body.base, open: true };
            pulls.push(pull);
            return Response.json({ number: pull.number, html_url: `https://github.com/acme/site/pull/${pull.number}` }, { status: 201 });
        }
        return Response.json({ message: "Not Found" }, { status: 404 });
    });
    return { fetch, branches, pulls, writes, headers };
}
const installer = (gh, templates = TEMPLATES) => createWorkflowInstaller({ token: TOKEN, fetch: gh.fetch, templates });
const errorOf = async (promise) => {
    try {
        await promise;
    }
    catch (err) {
        return err;
    }
    throw new Error("expected a rejection");
};
describe("workflow install, PR mode", () => {
    test("creates the install branch with every file and opens one PR, a second install reports the same PR", async () => {
        const gh = fakeGithub();
        const first = await installer(gh).install({ repo: "acme/site", templateId: "demo", mode: "pr" });
        expect(first).toMatchObject({
            outcome: "pr-opened",
            branch: BRANCH,
            filesWritten: [".github/workflows/demo.yml", ".agents/skills/demo/SKILL.md"],
            pullRequest: { number: 1, url: "https://github.com/acme/site/pull/1" },
        });
        expect(gh.branches[BRANCH]).toEqual({ ".github/workflows/demo.yml": "name: demo v1", ".agents/skills/demo/SKILL.md": "skill v1" });
        expect(gh.branches.main).toEqual({});
        const again = await installer(gh).install({ repo: "acme/site", templateId: "demo", mode: "pr" });
        expect(again).toMatchObject({ outcome: "pr-exists", filesWritten: [], pullRequest: { number: 1 } });
        expect(gh.pulls).toHaveLength(1);
        expect(gh.writes).toHaveLength(2);
    });
    test("an open install PR is brought up to date when the template changed", async () => {
        const gh = fakeGithub();
        await installer(gh).install({ repo: "acme/site", templateId: "demo", mode: "pr" });
        const updated = await installer(gh, templatesWith("name: demo v2")).install({ repo: "acme/site", templateId: "demo", mode: "pr" });
        expect(updated).toMatchObject({ outcome: "pr-exists", filesWritten: [".github/workflows/demo.yml"], pullRequest: { number: 1 } });
        expect(gh.branches[BRANCH]?.[".github/workflows/demo.yml"]).toBe("name: demo v2");
        expect(gh.pulls).toHaveLength(1);
    });
    test("identical files on the default branch are reported, nothing is created", async () => {
        const gh = fakeGithub();
        gh.branches.main = { ".github/workflows/demo.yml": "name: demo v1", ".agents/skills/demo/SKILL.md": "skill v1" };
        const result = await installer(gh).install({ repo: "acme/site", templateId: "demo", mode: "pr" });
        expect(result).toMatchObject({ outcome: "already-installed", branch: "main", filesWritten: [], pullRequest: null });
        expect(Object.keys(gh.branches)).toEqual(["main"]);
        expect(gh.pulls).toHaveLength(0);
    });
});
describe("workflow install, direct mode", () => {
    test("commits only the files that differ to the default branch, then reports it installed", async () => {
        const gh = fakeGithub();
        gh.branches.main = { ".agents/skills/demo/SKILL.md": "skill v1", ".github/workflows/demo.yml": "name: old" };
        const result = await installer(gh).install({ repo: "acme/site", templateId: "demo", mode: "direct" });
        expect(result).toMatchObject({ outcome: "committed", branch: "main", filesWritten: [".github/workflows/demo.yml"], pullRequest: null });
        expect(gh.branches.main?.[".github/workflows/demo.yml"]).toBe("name: demo v1");
        const again = await installer(gh).install({ repo: "acme/site", templateId: "demo", mode: "direct" });
        expect(again.outcome).toBe("already-installed");
        expect(gh.writes).toEqual(["main:.github/workflows/demo.yml"]);
    });
});
describe("workflow status", () => {
    test("reports missing, differing and installed templates and the open install PR", async () => {
        const gh = fakeGithub();
        const other = buildTemplates({ "other.yml": "name: other" }, { "other.yml": { title: "Other", description: "", requiredSecrets: [], requiredVariables: [] } });
        const both = [...TEMPLATES, ...other];
        const missing = await installer(gh, both).status("acme/site");
        expect(missing).toEqual({
            repo: "acme/site",
            defaultBranch: "main",
            templates: [
                { templateId: "demo", state: "missing", changedFiles: [".github/workflows/demo.yml", ".agents/skills/demo/SKILL.md"], pullRequest: null },
                { templateId: "other", state: "missing", changedFiles: [".github/workflows/other.yml"], pullRequest: null },
            ],
        });
        await installer(gh, both).install({ repo: "acme/site", templateId: "demo", mode: "pr" });
        gh.branches.main = { ".github/workflows/demo.yml": "name: demo v1", ".github/workflows/other.yml": "name: other" };
        const after = await installer(gh, both).status("acme/site");
        expect(after.templates).toEqual([
            {
                templateId: "demo",
                state: "differs",
                changedFiles: [".agents/skills/demo/SKILL.md"],
                pullRequest: { number: 1, url: "https://github.com/acme/site/pull/1" },
            },
            { templateId: "other", state: "installed", changedFiles: [], pullRequest: null },
        ]);
    });
    test("check reports one template, from missing to installed after a direct install", async () => {
        const gh = fakeGithub();
        expect(await installer(gh).check("acme/site", "demo")).toEqual({
            repo: "acme/site",
            defaultBranch: "main",
            template: { templateId: "demo", state: "missing", changedFiles: [".github/workflows/demo.yml", ".agents/skills/demo/SKILL.md"], pullRequest: null },
        });
        await installer(gh).install({ repo: "acme/site", templateId: "demo", mode: "direct" });
        expect((await installer(gh).check("acme/site", "demo")).template.state).toBe("installed");
        await expect(installer(gh).check("acme/site", "nope")).rejects.toMatchObject({ kind: "unknown-template" });
    });
});
describe("workflow install errors", () => {
    test("without a token nothing is called and the message points at the Integrations page", async () => {
        const gh = fakeGithub();
        const err = await errorOf(createWorkflowInstaller({ token: undefined, fetch: gh.fetch, templates: TEMPLATES }).status("acme/site"));
        expect(err).toMatchObject({ kind: "not-configured", message: expect.stringContaining("Integrations page") });
        expect(gh.headers).toEqual([]);
    });
    test("an unknown template is its own error kind", async () => {
        const err = await errorOf(installer(fakeGithub()).install({ repo: "acme/site", templateId: "nope", mode: "pr" }));
        expect(err.kind).toBe("unknown-template");
    });
    test("a repository the token cannot see says so", async () => {
        const err = await errorOf(installer(fakeGithub()).status("acme/elsewhere"));
        expect(err.message).toBe("Repository acme/elsewhere was not found, or the GitHub token cannot see it. Give the token access to it.");
    });
    test.each([403, 404])("a %i on writing a workflow names the permissions the token needs", async (status) => {
        const gh = fakeGithub({ deny: (method, path) => (method === "PUT" && path.includes(".github/workflows") ? status : undefined) });
        const err = await errorOf(installer(gh).install({ repo: "acme/site", templateId: "demo", mode: "direct" }));
        expect(err.message).toBe("The GitHub token cannot write .github/workflows/demo.yml in acme/site. It needs Contents, Pull requests and Workflows read and write access on this repository.");
        expect(err.message).not.toContain(TOKEN);
    });
    test("a rejected token and a rate limit get their own messages", async () => {
        const rejected = await errorOf(installer(fakeGithub({ deny: () => 401 })).status("acme/site"));
        expect(rejected.message).toContain("GitHub rejected the token");
        const limited = createWorkflowInstaller({
            token: TOKEN,
            templates: TEMPLATES,
            fetch: (async () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } })),
        });
        expect((await errorOf(limited.status("acme/site"))).message).toContain("rate limit");
    });
});

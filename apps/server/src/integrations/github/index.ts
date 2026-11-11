import { defineModule } from "../module";

const API = "https://api.github.com";

export const github = defineModule({
  id: "github",
  build: () => ({}),
  async test({ github }, { fetch: doFetch = fetch }) {
    if (!github.configured) return { ok: false, available: true, message: "GitHub token is not set" };
    const call = (path: string) =>
      doFetch(`${API}${path}`, {
        headers: {
          authorization: `Bearer ${github.values.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "automation-server",
        },
      });

    const user = await call("/user");
    if (user.status === 401) return { ok: false, available: true, message: "GitHub rejected the token (401)" };
    if (!user.ok) return { ok: false, available: true, message: `GitHub answered ${user.status} for GET /user` };
    const login = ((await user.json().catch(() => ({}))) as { login?: string }).login ?? "unknown";

    const repo = github.values.repo;
    if (!repo) return { ok: true, available: true, message: `Token is valid for ${login}. No issues repository is set.`, details: { user: login } };

    const res = await call(`/repos/${repo}`);
    if (res.status === 404) {
      return { ok: false, available: true, message: `Token is valid for ${login} but cannot see ${repo}`, details: { user: login } };
    }
    if (!res.ok) return { ok: false, available: true, message: `GitHub answered ${res.status} for ${repo}`, details: { user: login } };
    const body = (await res.json().catch(() => ({}))) as { private?: boolean; permissions?: { push?: boolean } };
    return {
      ok: true,
      available: true,
      message: `Token is valid for ${login} and can see ${repo}`,
      details: {
        user: login,
        repo,
        visibility: body.private ? "private" : "public",
        ...(body.permissions ? { push: String(body.permissions.push === true) } : {}),
      },
    };
  },
});

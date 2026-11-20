import { GITHUB_API, githubHeaders } from "@automation-server/api/githubApi";
import { parseExpiry } from "@automation-server/settings";
import { z } from "zod";
import { defineModule } from "../module";
const EXPIRY_HEADER = "github-authentication-token-expiration";
const userSchema = z.object({ login: z.string().optional() });
const repoSchema = z.object({ private: z.boolean().optional(), permissions: z.object({ push: z.boolean().optional() }).optional() });
export const github = defineModule({
    id: "github",
    build: () => ({}),
    async test({ github }, { fetch: doFetch = fetch }) {
        if (!github.configured)
            return { ok: false, available: true, message: "GitHub token is not set" };
        const call = (path) => doFetch(`${GITHUB_API}${path}`, { headers: githubHeaders(github.values.token) });
        const user = await call("/user");
        if (user.status === 401)
            return { ok: false, available: true, message: "GitHub rejected the token (401)" };
        if (!user.ok)
            return { ok: false, available: true, message: `GitHub answered ${user.status} for GET /user` };
        const login = userSchema.safeParse(await user.json().catch(() => null)).data?.login ?? "unknown";
        // Only fine-grained tokens send this header, and classic tokens never expire, so a missing or odd value means no expiry.
        const expiry = parseExpiry(user.headers.get(EXPIRY_HEADER)?.trim());
        const expiresAt = expiry ? { expiresAt: expiry } : {};
        const repo = github.values.repo;
        if (!repo)
            return { ok: true, available: true, ...expiresAt, message: `Token is valid for ${login}. No issues repository is set.`, details: { user: login } };
        const res = await call(`/repos/${repo}`);
        if (res.status === 404) {
            return { ok: false, available: true, ...expiresAt, message: `Token is valid for ${login} but cannot see ${repo}`, details: { user: login } };
        }
        if (!res.ok)
            return { ok: false, available: true, ...expiresAt, message: `GitHub answered ${res.status} for ${repo}`, details: { user: login } };
        const body = repoSchema.safeParse(await res.json().catch(() => null)).data ?? {};
        return {
            ok: true,
            available: true,
            ...expiresAt,
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

export type ServerConfig = {
  port: number;
  databasePath: string;
  sentry: {
    clientSecret: string;
    authToken?: string;
    apiBaseUrl: string;
  };
  github: {
    token: string;
    repo: { owner: string; name: string };
  };
  adminToken?: string;
  retentionDays: number;
  filters: {
    levels: string[];
    environments: string[];
    minEventCount: number;
  };
};

export type RawEnv = {
  PORT: number;
  DATABASE_PATH: string;
  SENTRY_CLIENT_SECRET: string;
  SENTRY_AUTH_TOKEN?: string;
  SENTRY_API_BASE_URL: string;
  SENTRY_LEVELS: string;
  SENTRY_ENVIRONMENTS?: string;
  SENTRY_MIN_EVENT_COUNT: number;
  GITHUB_TOKEN: string;
  GITHUB_REPO: string;
  ADMIN_API_TOKEN?: string;
  LOG_RETENTION_DAYS: number;
};

export const parseCsv = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

export function parseRepo(value: string): { owner: string; name: string } {
  const parts = value.trim().split("/");
  const [owner, name] = parts;
  if (parts.length !== 2 || !owner || !name) {
    throw new Error(`GITHUB_REPO must be in owner/name form, got "${value}"`);
  }
  return { owner, name };
}

export function buildConfig(env: RawEnv): ServerConfig {
  return {
    port: env.PORT,
    databasePath: env.DATABASE_PATH,
    sentry: {
      clientSecret: env.SENTRY_CLIENT_SECRET,
      authToken: env.SENTRY_AUTH_TOKEN || undefined,
      apiBaseUrl: env.SENTRY_API_BASE_URL,
    },
    adminToken: env.ADMIN_API_TOKEN || undefined,
    retentionDays: env.LOG_RETENTION_DAYS,
    github: { token: env.GITHUB_TOKEN, repo: parseRepo(env.GITHUB_REPO) },
    filters: {
      levels: parseCsv(env.SENTRY_LEVELS),
      environments: parseCsv(env.SENTRY_ENVIRONMENTS),
      minEventCount: env.SENTRY_MIN_EVENT_COUNT,
    },
  };
}

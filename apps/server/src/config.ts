export type ServerConfig = {
  port: number;
  databasePath: string;
  adminToken?: string;
  retentionDays: number;
  encryptionKey?: string;
  publicUrl?: string;
  adminPublicUrl?: string;
};

export type RawEnv = {
  PORT: number;
  DATABASE_PATH: string;
  ADMIN_API_TOKEN?: string;
  LOG_RETENTION_DAYS: number;
  SETTINGS_ENCRYPTION_KEY?: string;
  PUBLIC_URL?: string;
  ADMIN_PUBLIC_URL?: string;
};

export function buildConfig(env: RawEnv): ServerConfig {
  return {
    port: env.PORT,
    databasePath: env.DATABASE_PATH,
    adminToken: env.ADMIN_API_TOKEN || undefined,
    retentionDays: env.LOG_RETENTION_DAYS,
    encryptionKey: env.SETTINGS_ENCRYPTION_KEY || undefined,
    publicUrl: env.PUBLIC_URL ? env.PUBLIC_URL.replace(/\/+$/, "") : undefined,
    adminPublicUrl: env.ADMIN_PUBLIC_URL ? env.ADMIN_PUBLIC_URL.replace(/\/+$/, "") : undefined,
  };
}

export function webhookUrls(project: string, sources: readonly string[], publicUrl: string | undefined): Record<string, string> {
  return Object.fromEntries(sources.map((name) => [name, `${publicUrl ?? ""}/webhooks/${project}/${name}`]));
}

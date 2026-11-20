export function buildConfig(env) {
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
export function webhookUrls(project, sources, publicUrl) {
    return Object.fromEntries(sources.map((name) => [name, `${publicUrl ?? ""}/webhooks/${project}/${name}`]));
}

import type { Database } from "bun:sqlite";

export type Migration = (db: Database) => void;

// Versions are kept per component instead of in PRAGMA user_version because the claim, activity and settings stores share one database file.
export function migrate(db: Database, component: string, migrations: readonly Migration[]): void {
  db.transaction(() => {
    db.run("CREATE TABLE IF NOT EXISTS schema_versions (component TEXT PRIMARY KEY, version INTEGER NOT NULL)");
    const current =
      db
        .query<{ version: number }, { $component: string }>("SELECT version FROM schema_versions WHERE component = $component")
        .get({ $component: component })?.version ?? 0;
    if (current >= migrations.length) return;
    for (const step of migrations.slice(current)) step(db);
    db.query(
      "INSERT INTO schema_versions (component, version) VALUES ($component, $version) ON CONFLICT(component) DO UPDATE SET version = excluded.version",
    ).run({ $component: component, $version: migrations.length });
  }).immediate();
}

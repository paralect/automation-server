import { createSqliteLedger } from "@automation-server/ledger/server";
import { createSqliteSettingsStore } from "@automation-server/settings";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../scripts/demo-ledger.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "demo-ledger-"));
  dirs.push(dir);
  return dir;
};

// Run from an empty directory so Bun loads no .env, as the database path must come from the test alone.
const runScript = (cwd: string, env: Record<string, string>) => {
  const proc = Bun.spawnSync(["bun", SCRIPT], { cwd, env: { PATH: process.env.PATH ?? "", ...env } });
  return { exitCode: proc.exitCode, stderr: proc.stderr.toString() };
};

const budgetOf = (path: string) => {
  const settings = createSqliteSettingsStore({ path, encryptionKey: "k" });
  try {
    return settings.project("default").all()["openrouter.monthlyBudgetUsd"];
  } finally {
    settings.close();
  }
};

const prCount = (path: string) => {
  const ledger = createSqliteLedger({ path });
  try {
    return ledger.pullRequests({ project: "default", limit: 1000 }).items.length;
  } finally {
    ledger.close();
  }
};

describe("demo ledger script", () => {
  test("refuses a database file that already exists and leaves it untouched", () => {
    const dir = tempDir();
    const path = join(dir, "automation.db");
    const settings = createSqliteSettingsStore({ path, encryptionKey: "k" });
    settings.project("default").apply({ set: [{ key: "openrouter.monthlyBudgetUsd", json: "999", secret: false }] });
    settings.close();
    const before = budgetOf(path);

    const result = runScript(dir, { DATABASE_PATH: path });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("DEMO_FORCE=1");
    expect(budgetOf(path)).toEqual(before);
    expect(prCount(path)).toBe(0);
  });

  test("seeds a new file, and an existing one only with DEMO_FORCE=1", () => {
    const dir = tempDir();
    const path = join(dir, "demo.db");
    expect(runScript(dir, { DATABASE_PATH: path }).exitCode).toBe(0);
    const seeded = prCount(path);
    expect(seeded).toBeGreaterThan(0);
    expect(runScript(dir, { DATABASE_PATH: path, DEMO_FORCE: "1" }).exitCode).toBe(0);
    expect(prCount(path)).toBe(seeded);
  }, 30_000);
});

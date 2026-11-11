import type { EnvSource } from "./resolve";

/** The project that existed settings move into, and the only one that falls back to environment variables. */
export const DEFAULT_PROJECT_ID = "default";

export type Project = {
  /** Stable slug used in webhook URLs and setting keys. Never changes after creation. */
  readonly id: string;
  readonly name: string;
  /** Hostname such as `example.com`. The admin shows its favicon as the project icon. */
  readonly domain: string | null;
  readonly createdAt: string;
};

export class ProjectInputError extends Error {}

export const PROJECT_ID_PATTERN = "^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$";
const PROJECT_ID = new RegExp(PROJECT_ID_PATTERN);
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

export const isProjectId = (id: string) => PROJECT_ID.test(id);

/** Only the default project reads the legacy environment variables, so a new project starts empty. */
export const envFor = (projectId: string, env: EnvSource): EnvSource => (projectId === DEFAULT_PROJECT_ID ? env : {});

export function normalizeName(input: string): string {
  const name = input.trim().replace(/\s+/g, " ");
  if (name.length === 0) throw new ProjectInputError("Name is required");
  if (name.length > 60) throw new ProjectInputError("Name must be at most 60 characters");
  return name;
}

/** Accepts a hostname or a URL and keeps only the hostname. Empty means no domain. */
export function normalizeDomain(input: string | null | undefined): string | null {
  const raw = (input ?? "").trim().toLowerCase();
  if (raw.length === 0) return null;
  let host = raw;
  try {
    host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    throw new ProjectInputError(`"${input}" is not a domain`);
  }
  host = host.replace(/^www\./, "");
  if (!HOSTNAME.test(host)) throw new ProjectInputError(`"${input}" is not a domain`);
  return host;
}

/** A readable slug from the name, made unique against the taken ids. */
export function projectIdFor(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/, "") || "project";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

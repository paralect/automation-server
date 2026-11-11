import { INTEGRATIONS, INTEGRATION_IDS, type FieldSpec, type IntegrationId, type IntegrationValues } from "./spec";
import type { SettingsStore } from "./store";

export type EnvSource = Readonly<Record<string, string | undefined>>;

export type Origin = "db" | "env" | "default" | "unset";

type Base<I extends IntegrationId> = {
  readonly id: I;
  readonly origin: Readonly<Record<string, Origin>>;
};

export type ResolvedIntegration<I extends IntegrationId> =
  | (Base<I> & { readonly configured: true; readonly missing: readonly []; readonly values: IntegrationValues<I> })
  | (Base<I> & { readonly configured: false; readonly missing: readonly string[]; readonly values: Partial<IntegrationValues<I>> });

export type ResolvedConfig = { readonly [I in IntegrationId]: ResolvedIntegration<I> };

export const settingKey = (id: string, field: string) => `${id}.${field}`;

export const parseCsv = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

export function parseRepo(value: string): { owner: string; name: string } {
  const parts = value.trim().split("/");
  const [owner, name] = parts;
  if (parts.length !== 2 || !owner || !name) {
    throw new Error(`Repository must be in owner/name form, got "${value}"`);
  }
  return { owner, name };
}

type Value = string | number | boolean | string[];

const fromEnv = (field: FieldSpec, raw: string): Value | undefined => {
  switch (field.kind) {
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    case "boolean":
      return /^(true|1|yes|on)$/i.test(raw.trim());
    case "list":
      return parseCsv(raw);
    default:
      return raw;
  }
};

const fromJson = (field: FieldSpec, json: string): Value | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  switch (field.kind) {
    case "number":
      return typeof value === "number" ? value : undefined;
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "list":
      return Array.isArray(value) && value.every((v) => typeof v === "string") ? value : undefined;
    default:
      return typeof value === "string" ? value : undefined;
  }
};

const defaultOf = (field: FieldSpec): Value | undefined =>
  Array.isArray(field.default) ? [...field.default] : (field.default as Value | undefined);

const isMissing = (value: Value | undefined) => value === undefined || value === "";

export type ResolvedField = { value: Value | undefined; origin: Origin };

export function resolveField(
  id: string,
  field: FieldSpec,
  stored: ReturnType<SettingsStore["all"]>,
  env: EnvSource,
): ResolvedField {
  const row = stored[settingKey(id, field.key)];
  if (row?.json != null) {
    const value = fromJson(field, row.json);
    if (value !== undefined) return { value, origin: "db" };
  }
  const raw = field.env ? env[field.env] : undefined;
  if (raw !== undefined && raw !== "") {
    const value = fromEnv(field, raw);
    if (value !== undefined) return { value, origin: "env" };
  }
  const fallback = defaultOf(field);
  return fallback === undefined ? { value: undefined, origin: "unset" } : { value: fallback, origin: "default" };
}

export function resolveConfig(store: Pick<SettingsStore, "all">, env: EnvSource): ResolvedConfig {
  const stored = store.all();
  const out: Record<string, unknown> = {};
  for (const id of INTEGRATION_IDS) {
    const spec = INTEGRATIONS[id];
    const values: Record<string, Value> = {};
    const origin: Record<string, Origin> = {};
    const missing: string[] = [];
    for (const field of spec.fields as readonly FieldSpec[]) {
      const resolved = resolveField(id, field, stored, env);
      origin[field.key] = resolved.origin;
      if (resolved.value !== undefined) values[field.key] = resolved.value;
      if (field.required && isMissing(resolved.value)) missing.push(field.key);
    }
    out[id] = { id, configured: missing.length === 0, missing, values, origin };
  }
  return out as ResolvedConfig;
}

export function envNames(): string[] {
  return INTEGRATION_IDS.flatMap((id) =>
    (INTEGRATIONS[id].fields as readonly FieldSpec[]).flatMap((f) => (f.env ? [f.env] : [])),
  );
}

/** GitHub Actions repositories shown in the admin. Falls back to the issues repository. */
export function effectiveActionsRepos(github: ResolvedConfig["github"]): string[] {
  const listed = github.values.actionsRepos ?? [];
  const repos = listed.length > 0 ? listed : github.values.repo ? [github.values.repo] : [];
  return [...new Set(repos.map((r) => {
    const { owner, name } = parseRepo(r);
    return `${owner}/${name}`;
  }))];
}

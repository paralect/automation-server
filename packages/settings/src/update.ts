import { z } from "zod";

import type { IntegrationHealth, StoredHealth } from "./health";
import { resolveField, settingKey, type EnvSource, type Origin, type ResolvedConfig } from "./resolve";
import { INTEGRATIONS, type FieldSpec, type IntegrationId } from "./spec";
import type { SettingWrite, SettingsStore } from "./store";

export class SettingsInputError extends Error {}

const withPattern = (schema: z.ZodString, field: FieldSpec): z.ZodType =>
  field.pattern ? z.union([z.literal(""), schema.regex(new RegExp(field.pattern), field.patternHint ?? "invalid format")]) : schema;

const fieldSchema = (field: FieldSpec): z.ZodType => {
  switch (field.kind) {
    case "number": {
      let n = z.number();
      if (field.min !== undefined) n = n.min(field.min);
      if (field.max !== undefined) n = n.max(field.max);
      return n;
    }
    case "boolean":
      return z.boolean();
    case "select":
      return z.enum([...(field.options ?? [])] as [string, ...string[]]);
    case "list":
    case "slackUsers":
    case "slackChannels": {
      const item = field.pattern ? z.string().trim().regex(new RegExp(field.pattern)) : z.string().trim();
      return z.array(item.min(1).max(500)).max(100);
    }
    case "secret":
      return withPattern(z.string().max(4000), field);
    default:
      return withPattern(z.string().trim().max(2000), field);
  }
};

export function updateSchema(id: IntegrationId) {
  const shape: Record<string, z.ZodType> = {};
  for (const field of INTEGRATIONS[id].fields as readonly FieldSpec[]) shape[field.key] = fieldSchema(field).optional();
  return z.object(shape).strict();
}

export type SettingsChange = { readonly set: SettingWrite[]; readonly remove: string[] };

export function planUpdate(
  id: IntegrationId,
  input: { values?: Record<string, unknown>; clear?: readonly string[] },
): SettingsChange {
  const fields = INTEGRATIONS[id].fields as readonly FieldSpec[];
  const known = new Set(fields.map((f) => f.key));
  const parsed = updateSchema(id).safeParse(input.values ?? {});
  if (!parsed.success) {
    throw new SettingsInputError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "values"}: ${i.message}`).join("; "),
    );
  }
  const values = parsed.data as Record<string, unknown>;
  const remove = [...new Set(input.clear ?? [])];
  const unknown = remove.filter((k) => !known.has(k));
  if (unknown.length > 0) throw new SettingsInputError(`unknown field: ${unknown.join(", ")}`);

  const set: SettingWrite[] = [];
  for (const field of fields) {
    const value = values[field.key];
    if (value === undefined || remove.includes(field.key)) continue;
    if (field.kind === "secret") {
      if (typeof value === "string" && value.length > 0) set.push({ key: settingKey(id, field.key), json: JSON.stringify(value), secret: true });
      continue;
    }
    set.push({ key: settingKey(id, field.key), json: JSON.stringify(value), secret: false });
  }
  return { set, remove: remove.map((k) => settingKey(id, k)) };
}

export type FieldView = {
  readonly key: string;
  readonly label: string;
  readonly kind: FieldSpec["kind"];
  readonly required: boolean;
  readonly help?: string;
  readonly group?: string;
  readonly groupHelp?: string;
  readonly options?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly default?: FieldSpec["default"];
  readonly source: Origin;
  readonly value?: string | number | boolean | string[];
  readonly set: boolean;
};

export type IntegrationView = {
  readonly id: IntegrationId;
  readonly title: string;
  readonly description: string;
  readonly webhookSource?: string;
  readonly configured: boolean;
  readonly missing: readonly string[];
  readonly fields: FieldView[];
  readonly health?: IntegrationHealth;
};

export type SettingsView = {
  readonly secretsWritable: boolean;
  readonly integrations: IntegrationView[];
};

export function describeSettings(
  store: Pick<SettingsStore, "all" | "canStoreSecrets">,
  env: EnvSource,
  resolved: ResolvedConfig,
  health: Readonly<Record<string, StoredHealth>> = {},
): SettingsView {
  const stored = store.all();
  const integrations = (Object.keys(INTEGRATIONS) as IntegrationId[]).map((id): IntegrationView => {
    const spec = INTEGRATIONS[id];
    const recorded = resolved[id].configured ? health[id] : undefined;
    return {
      id,
      title: spec.title,
      description: spec.description,
      ...("webhookSource" in spec ? { webhookSource: spec.webhookSource } : {}),
      configured: resolved[id].configured,
      missing: resolved[id].missing,
      ...(recorded
        ? { health: { checkedAt: recorded.checkedAt, ok: recorded.ok, message: recorded.message, ...(recorded.expiresAt ? { expiresAt: recorded.expiresAt } : {}) } }
        : {}),
      fields: (spec.fields as readonly FieldSpec[]).map((field): FieldView => {
        const { value, origin } = resolveField(id, field, stored, env);
        const secret = field.kind === "secret";
        return {
          key: field.key,
          label: field.label,
          kind: field.kind,
          required: field.required === true,
          ...(field.help ? { help: field.help } : {}),
          ...(field.group ? { group: field.group } : {}),
          ...(field.groupHelp ? { groupHelp: field.groupHelp } : {}),
          ...(field.options ? { options: field.options } : {}),
          ...(field.min !== undefined ? { min: field.min } : {}),
          ...(field.max !== undefined ? { max: field.max } : {}),
          ...(field.default !== undefined ? { default: field.default } : {}),
          source: origin,
          set: value !== undefined && value !== "",
          ...(secret || value === undefined ? {} : { value }),
        };
      }),
    };
  });
  return { secretsWritable: store.canStoreSecrets, integrations };
}

export type ConnectionTestResult = {
  readonly ok: boolean;
  readonly available: boolean;
  readonly message: string;
  readonly expiresAt?: string;
  readonly details?: Readonly<Record<string, string>>;
};

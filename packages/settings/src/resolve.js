import { INTEGRATIONS, INTEGRATION_IDS, isListKind } from "./spec";
export const settingKey = (id, field) => `${id}.${field}`;
export const parseCsv = (value) => (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
export function parseRepo(value) {
    const parts = value.trim().split("/");
    const [owner, name] = parts;
    if (parts.length !== 2 || !owner || !name) {
        throw new Error(`Repository must be in owner/name form, got "${value}"`);
    }
    return { owner, name };
}
const fromEnv = (field, raw) => {
    if (isListKind(field.kind))
        return parseCsv(raw);
    switch (field.kind) {
        case "number": {
            const n = Number(raw);
            return Number.isFinite(n) ? n : undefined;
        }
        case "boolean":
            return /^(true|1|yes|on)$/i.test(raw.trim());
        default:
            return raw;
    }
};
const fromJson = (field, json) => {
    let value;
    try {
        value = JSON.parse(json);
    }
    catch {
        return undefined;
    }
    if (isListKind(field.kind))
        return Array.isArray(value) && value.every((v) => typeof v === "string") ? value : undefined;
    switch (field.kind) {
        case "number":
            return typeof value === "number" ? value : undefined;
        case "boolean":
            return typeof value === "boolean" ? value : undefined;
        default:
            return typeof value === "string" ? value : undefined;
    }
};
const defaultOf = (field) => Array.isArray(field.default) ? [...field.default] : field.default;
const isMissing = (value) => value === undefined || value === "";
export function resolveField(id, field, stored, env) {
    const row = stored[settingKey(id, field.key)];
    if (row?.json != null) {
        const value = fromJson(field, row.json);
        if (value !== undefined)
            return { value, origin: "db" };
    }
    const raw = field.env ? env[field.env] : undefined;
    if (raw !== undefined && raw !== "") {
        const value = fromEnv(field, raw);
        if (value !== undefined)
            return { value, origin: "env" };
    }
    const fallback = defaultOf(field);
    return fallback === undefined ? { value: undefined, origin: "unset" } : { value: fallback, origin: "default" };
}
const labelOf = (spec, key) => {
    const label = spec.fields.find((f) => f.key === key)?.label ?? key;
    return label.charAt(0).toLowerCase() + label.slice(1);
};
const article = (word) => (/^[aeiou]/i.test(word) ? "an" : "a");
// Nothing is set yet, so name every way to finish instead of one arbitrary group, for example "Add the bot token and signing secret, or an alerts webhook URL."
function oneOfSentence(spec, groups) {
    const ways = groups.map((group, i) => {
        const names = group.map((key) => labelOf(spec, key)).join(" and ");
        return i === 0 ? `the ${names}` : `${article(names)} ${names}`;
    });
    return `Add ${ways.join(", or ")}.`;
}
export function resolveConfig(store, env) {
    const stored = store.all();
    const out = {};
    for (const id of INTEGRATION_IDS) {
        const spec = INTEGRATIONS[id];
        const values = {};
        const origin = {};
        const missing = [];
        for (const field of spec.fields) {
            const resolved = resolveField(id, field, stored, env);
            origin[field.key] = resolved.origin;
            if (resolved.value !== undefined)
                values[field.key] = resolved.value;
            if (field.required && isMissing(resolved.value))
                missing.push(field.key);
        }
        const groups = spec.requiredOneOf;
        if (groups && groups.length > 0) {
            const gaps = groups.map((group) => group.filter((key) => isMissing(values[key])));
            if (gaps.every((gap) => gap.length > 0)) {
                // The group closest to done is the one worth naming, so a half-set bot does not ask for the webhook.
                const closeness = (i) => gaps[i].length - (groups[i].length - gaps[i].length);
                const nearest = gaps.map((_, i) => i).reduce((best, i) => (closeness(i) < closeness(best) ? i : best));
                const started = gaps[nearest].length < groups[nearest].length;
                missing.push(...(started ? gaps[nearest] : [oneOfSentence(spec, groups)]));
            }
        }
        out[id] = { id, configured: missing.length === 0, missing, values, origin };
    }
    return out;
}
export function envNames() {
    return INTEGRATION_IDS.flatMap((id) => INTEGRATIONS[id].fields.flatMap((f) => (f.env ? [f.env] : [])));
}
export function effectiveActionsRepos(github) {
    const listed = github.values.actionsRepos ?? [];
    const repos = listed.length > 0 ? listed : github.values.repo ? [github.values.repo] : [];
    const valid = [];
    for (const repo of repos) {
        try {
            const { owner, name } = parseRepo(repo);
            valid.push(`${owner}/${name}`);
        }
        catch {
            continue;
        }
    }
    return [...new Set(valid)];
}

import type { ParseResult } from "@automation-server/core/source";
import { z } from "zod";

import { SENTRY_ISSUE_ALERT, SENTRY_SOURCE } from "./event";
import type {
  SentryBreadcrumb,
  SentryException,
  SentryFrame,
  SentryIssueAlert,
} from "./types";

const MAX_BREADCRUMBS = 100;

const optStr = z.string().nullish();
const optNum = z.number().nullish();

const frameSchema = z.object({
  filename: optStr,
  module: optStr,
  function: optStr,
  lineno: optNum,
  colno: optNum,
  in_app: z.boolean().nullish(),
  context_line: optStr,
});

const exceptionSchema = z.object({
  type: optStr,
  value: optStr,
  stacktrace: z.object({ frames: z.array(frameSchema).nullish() }).nullish(),
});

const breadcrumbSchema = z.object({
  timestamp: z.union([z.string(), z.number()]).nullish(),
  type: optStr,
  category: optStr,
  level: optStr,
  message: optStr,
  data: z
    .object({
      url: optStr,
      method: optStr,
      status_code: optNum,
    })
    .nullish(),
});
type RawBreadcrumb = z.infer<typeof breadcrumbSchema>;

const breadcrumbList = z.array(breadcrumbSchema);

const eventSchema = z.object({
  issue_id: z.union([z.string(), z.number()]),
  issue_url: optStr,
  web_url: optStr,
  event_id: optStr,
  title: optStr,
  message: optStr,
  culprit: optStr,
  level: optStr,
  platform: optStr,
  environment: optStr,
  release: z.union([z.string(), z.object({ version: optStr })]).nullish(),
  datetime: optStr,
  tags: z.array(z.tuple([z.string(), z.unknown()], z.unknown())).nullish(),
  exception: z.object({ values: z.array(exceptionSchema).nullish() }).nullish(),
  breadcrumbs: z
    .union([breadcrumbList, z.object({ values: breadcrumbList.nullish() })])
    .nullish(),
  entries: z
    .array(
      z.object({
        type: optStr,
        data: z.object({ values: z.array(z.unknown()).nullish() }).nullish(),
      }),
    )
    .nullish(),
});

const payloadSchema = z.object({
  data: z.object({
    event: eventSchema,
    triggered_rule: optStr,
  }),
});

function toIso(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return new Date(value * 1000).toISOString();
}

function mapFrame(f: z.infer<typeof frameSchema>): SentryFrame {
  return {
    filename: f.filename ?? null,
    module: f.module ?? null,
    function: f.function ?? null,
    lineno: f.lineno ?? null,
    colno: f.colno ?? null,
    inApp: f.in_app === true,
    contextLine: f.context_line ?? null,
  };
}

function mapException(e: z.infer<typeof exceptionSchema>): SentryException {
  return {
    type: e.type ?? null,
    value: e.value ?? null,
    frames: (e.stacktrace?.frames ?? []).map(mapFrame),
  };
}

function mapBreadcrumb(b: RawBreadcrumb): SentryBreadcrumb {
  return {
    timestamp: toIso(b.timestamp),
    type: b.type ?? null,
    category: b.category ?? null,
    level: b.level ?? null,
    message: b.message ?? null,
    url: b.data?.url ?? null,
    method: b.data?.method ?? null,
    statusCode: b.data?.status_code ?? null,
  };
}

function collectBreadcrumbs(event: z.infer<typeof eventSchema>): SentryBreadcrumb[] {
  let raw: RawBreadcrumb[] = [];
  const direct = event.breadcrumbs;
  if (Array.isArray(direct)) raw = direct;
  else if (direct?.values) raw = direct.values;
  else {
    const entry = event.entries?.find((e) => e.type === "breadcrumbs");
    for (const item of entry?.data?.values ?? []) {
      const parsed = breadcrumbSchema.safeParse(item);
      if (parsed.success) raw.push(parsed.data);
    }
  }
  return raw.slice(0, MAX_BREADCRUMBS).map(mapBreadcrumb);
}

function tagValue(event: z.infer<typeof eventSchema>, key: string): string | null {
  for (const tag of event.tags ?? []) {
    if (tag[0] === key && typeof tag[1] === "string") return tag[1];
  }
  return null;
}

function releaseOf(event: z.infer<typeof eventSchema>): string | null {
  const r = event.release;
  if (typeof r === "string") return r;
  return r?.version ?? null;
}

function ignored(reason: string): ParseResult {
  return { type: "ignored", reason };
}

export function parseSentryWebhook(
  headers: Headers,
  rawBody: Uint8Array,
  receivedAt: Date,
): ParseResult {
  const resource = headers.get("sentry-hook-resource");
  if (resource !== "event_alert") {
    return ignored(`unsupported_resource:${resource ?? "missing"}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return ignored("invalid_json");
  }

  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success) return ignored("invalid_payload_shape");

  const { event, triggered_rule } = parsed.data.data;
  const payload: SentryIssueAlert = {
    issueId: String(event.issue_id),
    issueApiUrl: event.issue_url ?? null,
    eventId: event.event_id ?? null,
    eventWebUrl: event.web_url ?? null,
    title: event.title ?? event.message ?? "",
    level: event.level ?? "error",
    culprit: event.culprit ?? null,
    environment: tagValue(event, "environment") ?? event.environment ?? null,
    release: releaseOf(event),
    platform: event.platform ?? null,
    ruleName: triggered_rule ?? null,
    occurredAt: event.datetime ?? null,
    exceptions: (event.exception?.values ?? []).map(mapException),
    breadcrumbs: collectBreadcrumbs(event),
    issue: null,
  };

  return {
    type: "event",
    event: {
      source: SENTRY_SOURCE,
      kind: SENTRY_ISSUE_ALERT,
      externalId: payload.issueId,
      receivedAt: receivedAt.toISOString(),
      payload,
    },
  };
}

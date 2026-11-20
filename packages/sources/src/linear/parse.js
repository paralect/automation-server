import { z } from "zod";
import { LINEAR_ISSUE, LINEAR_SOURCE } from "./event";
const labelSchema = z.object({ id: z.string(), name: z.string() });
const payloadSchema = z.object({
    action: z.string(),
    type: z.string(),
    data: z.object({
        id: z.string(),
        identifier: z.string().nullish(),
        title: z.string().nullish(),
        description: z.string().nullish(),
        url: z.string().nullish(),
        labelIds: z.array(z.string()).nullish(),
        labels: z.array(labelSchema).nullish(),
        team: z.object({ key: z.string().nullish() }).nullish(),
        state: z.object({ name: z.string().nullish() }).nullish(),
        createdAt: z.string().nullish(),
        updatedAt: z.string().nullish(),
    }),
    updatedFrom: z.object({ labelIds: z.array(z.string()).nullish() }).nullish(),
    url: z.string().nullish(),
    createdAt: z.string().nullish(),
});
const ignored = (reason) => ({ type: "ignored", reason });
export function parseLinearWebhook(rawBody, receivedAt) {
    let json;
    try {
        json = JSON.parse(new TextDecoder().decode(rawBody));
    }
    catch {
        return ignored("invalid_json");
    }
    const parsed = payloadSchema.safeParse(json);
    if (!parsed.success)
        return ignored("invalid_payload_shape");
    const { action, type, data, updatedFrom } = parsed.data;
    if (type !== "Issue")
        return ignored(`unsupported_type:${type}`);
    if (action !== "create" && action !== "update")
        return ignored(`unsupported_action:${action}`);
    const nowIds = data.labelIds ?? data.labels?.map((l) => l.id) ?? [];
    let before;
    if (action === "create")
        before = new Set();
    else if (updatedFrom?.labelIds)
        before = new Set(updatedFrom.labelIds);
    else
        return ignored("labels_unchanged");
    const addedLabelIds = nowIds.filter((id) => !before.has(id));
    if (addedLabelIds.length === 0)
        return ignored("no_label_added");
    const updatedAt = data.updatedAt ?? data.createdAt ?? parsed.data.createdAt ?? receivedAt.toISOString();
    const payload = {
        action,
        issueId: data.id,
        identifier: data.identifier ?? data.id,
        title: data.title ?? "",
        description: data.description ?? "",
        url: data.url ?? parsed.data.url ?? "",
        teamKey: data.team?.key ?? null,
        state: data.state?.name ?? null,
        labels: data.labels ?? [],
        addedLabelIds,
        updatedAt,
    };
    return {
        type: "event",
        event: {
            source: LINEAR_SOURCE,
            kind: LINEAR_ISSUE,
            // The change time keeps a later re-add of the same label a new claim, while a redelivery of this change is a duplicate.
            externalId: `${data.id}:${addedLabelIds.join("+")}@${updatedAt}`,
            receivedAt: receivedAt.toISOString(),
            payload,
        },
    };
}

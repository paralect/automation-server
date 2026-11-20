import type { StoredEvent } from "@automation-server/core";
import { isSentryIssueAlert } from "@automation-server/sources/sentry/event";
import { z } from "zod";

// The stored event is a redacted copy of what an outside service sent, so it is parsed again rather than trusted.
const sentryLinks = z.object({
  eventWebUrl: z.string().nullish(),
  issue: z.object({ permalink: z.string().nullish() }).nullish(),
});

const httpsUrl = (value: string | null | undefined): string | null => {
  if (!value) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
};

// Where the thing that started a run lives, for the first node of the run's chain. Only Sentry links back today.
export function triggerUrl(event: StoredEvent | undefined): string | null {
  if (!event || !isSentryIssueAlert(event)) return null;
  const parsed = sentryLinks.safeParse(event.payload);
  if (!parsed.success) return null;
  return httpsUrl(parsed.data.issue?.permalink) ?? httpsUrl(parsed.data.eventWebUrl);
}

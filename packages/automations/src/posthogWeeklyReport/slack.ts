import type { SlackBlock } from "@chat-adapter/slack/blocks";
import { scrub } from "./scrub";

/** `text` is the notification and fallback. With `blocks`, Slack shows the blocks instead. */
export async function postToSlack(
  webhookUrl: string,
  text: string,
  { fetch: doFetch = fetch, timeoutMs = 15_000, blocks }: { fetch?: typeof fetch; timeoutMs?: number; blocks?: SlackBlock[] } = {},
): Promise<void> {
  const secrets = [webhookUrl, ...webhookUrl.split("/").filter((part) => part.length >= 8)];
  const fail = (what: string): never => {
    throw new Error(`Slack delivery failed: ${scrub(what, secrets)}`);
  };
  let res: Response;
  try {
    res = await doFetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(blocks ? { text, blocks } : { text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return fail(err instanceof Error && err.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) fail(`HTTP ${res.status} ${await res.text().catch(() => "")}`);
}

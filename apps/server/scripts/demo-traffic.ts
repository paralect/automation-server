import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const baseUrl = process.env.SERVER_URL ?? "http://localhost:3000";
const secret = process.env.SENTRY_CLIENT_SECRET;
if (!secret) throw new Error("SENTRY_CLIENT_SECRET is required");

const dir = new URL("../../../packages/sources/test/fixtures/", import.meta.url).pathname;
const sign = (body: string) => createHmac("sha256", secret).update(body).digest("hex");

const fixtures = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { data: { event: { issue_id: string | number } } });

const withIssueId = (fixture: (typeof fixtures)[number], issueId: string) => {
  const copy = structuredClone(fixture);
  copy.data.event.issue_id = issueId;
  return JSON.stringify(copy);
};

const post = async (label: string, path: string, body: string, signature: string) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "sentry-hook-resource": "event_alert", "sentry-hook-signature": signature },
    body,
  });
  console.log(`${label}: ${res.status}`);
};

for (const [i, fixture] of fixtures.entries()) {
  for (const n of [1, 2, 3]) {
    const body = withIssueId(fixture, `demo-${i}-${n}`);
    await post(`signed fixture ${i} issue ${n}`, "/webhooks/sentry", body, sign(body));
  }
}
const repeat = withIssueId(fixtures[0]!, "demo-0-1");
await post("redelivery of demo-0-1", "/webhooks/sentry", repeat, sign(repeat));
await post("bad signature", "/webhooks/sentry", repeat, "0".repeat(64));
await post("unknown source", "/webhooks/nope", repeat, sign(repeat));

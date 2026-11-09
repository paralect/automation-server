import { createDispatcher, createSqliteActivityStore, createSqliteStore, type Logger } from "@automation-server/core";
import { describe, expect, test } from "bun:test";

import { createApp } from "../src/app";

const TOKEN = "t".repeat(40);
const quiet: Logger = { info() {}, warn() {}, error() {} };

function setup(options: { adminToken?: string } = { adminToken: TOKEN }) {
  const { adminToken } = options;
  const activity = createSqliteActivityStore({ path: ":memory:" });
  const dispatcher = createDispatcher({ automations: [], store: createSqliteStore({ path: ":memory:" }), log: quiet });
  const app = createApp({
    sources: {},
    dispatcher,
    log: quiet,
    admin: {
      activity,
      adminToken,
      system: { startedAt: new Date().toISOString(), sources: ["sentry"], automations: ["a"], retentionDays: 30 },
    },
  });
  const call = (path: string, input: unknown, bearer?: string) =>
    app.request(`/rpc/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify({ json: input }),
    });
  return { activity, call };
}

describe("admin API auth", () => {
  test("no token gives 401", async () => {
    expect((await setup().call("overview", {})).status).toBe(401);
  });

  test("wrong token gives 401", async () => {
    expect((await setup().call("overview", {}, "w".repeat(40))).status).toBe(401);
  });

  test("a bearer is rejected when ADMIN_API_TOKEN is unset", async () => {
    const t = setup({});
    expect((await t.call("overview", {}, TOKEN)).status).toBe(401);
    expect((await t.call("system", undefined, "undefined")).status).toBe(401);
  });

  test("the correct token reads the overview", async () => {
    const t = setup();
    t.activity.recordDuplicate({ automation: "a", source: "s", kind: "k", externalId: "e", startedAt: new Date().toISOString() });
    const res = await t.call("overview", {}, TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json: { runs: Record<string, number> } };
    expect(body.json.runs.duplicate).toBe(1);
  });

  test("runs.get for an unknown id gives 404", async () => {
    expect((await setup().call("runs/get", { id: "nope" }, TOKEN)).status).toBe(404);
  });

  test("runs.get returns a stored run with its logs", async () => {
    const t = setup();
    const id = t.activity.startRun({ automation: "a", source: "s", kind: "k", externalId: "e", startedAt: new Date().toISOString() });
    t.activity.recordLog({ time: new Date().toISOString(), level: "info", message: "hello", fields: { runId: id } });
    const res = await t.call("runs/get", { id }, TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { json: { run: { id: string }; logs: { message: string }[] } };
    expect(body.json.run.id).toBe(id);
    expect(body.json.logs.map((l) => l.message)).toEqual(["hello"]);
  });
});

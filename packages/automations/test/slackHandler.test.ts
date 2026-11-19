import { createDispatcher, createSqliteActivityStore, createSqliteStore, type Event, type Logger } from "@automation-server/core";
import { slackBotOutcomeSchema } from "@automation-server/sources/slack/outcome";
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { createAgent, type AgentModel } from "../src/slackBot/agent";
import { createSlackBot, DENIED_REPLY } from "../src/slackBot/automation";
import type { PostMessage, SlackBotClient, SlackThreadMessage } from "../src/slackBot/client";
import { createAgentHandler, EMPTY_QUESTION_REPLY } from "../src/slackBot/handler";
import { buildReadTools } from "../src/slackBot/tools";

const SECRET_TOKEN = "xoxb-1234567890-ABCDEFGHIJ-secretsecret";

const mention = (user: string, patch: Record<string, unknown> = {}, id = "Ev1"): Event => ({
  project: "p",
  source: "slack",
  kind: "app_mention",
  externalId: id,
  receivedAt: "2026-01-01T00:00:00Z",
  payload: { team: "T1", channel: "C1", user, text: "what Linear issues mention billing?", ts: "100.1", threadTs: null, ...patch },
});

type Wire = { type: "tool" | "final"; tool: string | null; argsJson: string | null; text: string | null };

const setup = ({ script, replies = [], repliesFail = false, dry = false }: { script: Wire[]; replies?: SlackThreadMessage[]; repliesFail?: boolean; dry?: boolean }) => {
  const posted: PostMessage[] = [];
  const logs: string[] = [];
  const prompts: string[] = [];
  const fetched: string[] = [];
  const log: Logger = {
    info: (m, f) => void logs.push(JSON.stringify({ m, f })),
    warn: (m, f) => void logs.push(JSON.stringify({ m, f })),
    error: (m, f) => void logs.push(JSON.stringify({ m, f })),
  };
  const client: SlackBotClient = {
    authTest: async () => ({ botName: "b", botUserId: "UBOT", team: "t", teamId: "T1" }),
    replies: async ({ threadTs }) => {
      fetched.push(threadTs);
      if (repliesFail) throw new Error(`missing_scope for ${SECRET_TOKEN}`);
      return replies;
    },
    postMessage: async (message) => {
      posted.push(message);
      return { ts: "200.1" };
    },
  };
  const model: AgentModel = {
    structured: (async (req: { user: string; schema: z.ZodType }) => {
      prompts.push(req.user);
      const next = script.shift();
      if (!next) throw new Error("script ran out");
      return req.schema.parse(next);
    }) as AgentModel["structured"],
  };
  const linearFetch = (async () =>
    Response.json({ data: { searchIssues: { nodes: [{ identifier: "ENG-1", title: "Billing <!channel>", url: "https://linear.app/x", state: { name: "Todo" }, assignee: null }] } } })) as unknown as typeof fetch;
  const tools = buildReadTools({ linear: { apiKey: "lin_api_secretsecretsecret" }, fetch: linearFetch });
  const agent = createAgent({ model, modelName: "m/x", tools });
  const base = createSlackBot({ client, allowedUsers: ["UOK"], handler: createAgentHandler(agent) });
  const bot = { ...base, ...(dry ? { dryRun: true } : {}), project: "p" };
  const activity = createSqliteActivityStore({ path: ":memory:" });
  const dispatcher = createDispatcher({ automations: () => [bot], store: createSqliteStore({ path: ":memory:" }), log, activity });
  const send = async (event: Event) => {
    dispatcher.enqueue(event);
    await dispatcher.drain(2000);
  };
  const run = () => {
    const item = activity.queryRuns({ limit: 1 }).items[0]!;
    return { item, outcome: activity.getRun(item.id)?.run.outcome };
  };
  return { posted, logs, prompts, fetched, send, run, script };
};

describe("slack agent end to end through the dispatcher", () => {
  test("a listed user's question runs a tool, replies in the thread with an escaped answer and logs the step", async () => {
    const t = setup({
      script: [
        { type: "tool", tool: "linear.searchIssues", argsJson: '{"query":"billing"}', text: null },
        { type: "final", tool: null, argsJson: null, text: "ENG-1 <!channel> mentions billing" },
      ],
    });
    await t.send(mention("UOK"));
    expect(t.posted).toEqual([{ channel: "C1", threadTs: "100.1", text: "ENG-1 &lt;!channel&gt; mentions billing" }]);
    expect(t.logs.some((l) => l.includes("agent step") && l.includes("linear.searchIssues") && l.includes('{\\"query\\":\\"billing\\"}'))).toBe(true);
    const { item, outcome } = t.run();
    expect(item.status).toBe("succeeded");
    expect(slackBotOutcomeSchema.parse(outcome).agent).toMatchObject({ status: "answered", stepCount: 1, toolsUsed: ["linear.searchIssues"] });
    expect(t.prompts[1]).toContain("Billing ‹!channel›");
  });

  test("an unlisted user never reaches the agent: no model call, no tool call, no thread read", async () => {
    const t = setup({ script: [] });
    await t.send(mention("UNOPE", { threadTs: "50.5" }));
    expect(t.posted).toEqual([{ channel: "C1", threadTs: "50.5", text: DENIED_REPLY }]);
    expect(t.prompts).toEqual([]);
    expect(t.fetched).toEqual([]);
  });

  test("a mention inside a thread reads the thread, labels the bot's own messages, and leaves the mention itself out", async () => {
    const t = setup({
      script: [{ type: "final", tool: null, argsJson: null, text: "ok" }],
      replies: [
        { ts: "50.5", user: "U2", botId: null, text: "billing looks off" },
        { ts: "60.1", user: "UBOT", botId: null, text: "I will check" },
        { ts: "100.1", user: "UOK", botId: null, text: "what Linear issues mention billing?" },
      ],
    });
    await t.send(mention("UOK", { threadTs: "50.5" }));
    expect(t.fetched).toEqual(["50.5"]);
    expect(t.prompts[0]).toContain("[user U2] billing looks off");
    expect(t.prompts[0]).toContain("[assistant] I will check");
    expect(t.prompts[0]!.match(/what Linear issues mention billing\?/g)).toHaveLength(1);
    expect(t.posted[0]!.threadTs).toBe("50.5");
  });

  test("a top-level mention reads no thread", async () => {
    const t = setup({ script: [{ type: "final", tool: null, argsJson: null, text: "ok" }] });
    await t.send(mention("UOK"));
    expect(t.fetched).toEqual([]);
  });

  test("a thread that cannot be read does not stop the answer, and the token never reaches the log", async () => {
    const t = setup({ script: [{ type: "final", tool: null, argsJson: null, text: "ok" }], repliesFail: true });
    await t.send(mention("UOK", { threadTs: "50.5" }));
    expect(t.posted[0]!.text).toBe("ok");
    expect(t.logs.some((l) => l.includes("could not read the thread"))).toBe(true);
    expect(t.logs.join("\n")).not.toContain("secretsecret");
  });

  test("an empty mention gets a hint and no model call", async () => {
    const t = setup({ script: [] });
    await t.send(mention("UOK", { text: "  " }));
    expect(t.posted[0]!.text).toBe(EMPTY_QUESTION_REPLY);
    expect(t.prompts).toEqual([]);
  });

  test("a model failure posts 'I could not do that' and the run still succeeds", async () => {
    const t = setup({ script: [] });
    await t.send(mention("UOK"));
    expect(t.posted[0]!.text).toStartWith("I could not do that: ");
    const { item, outcome } = t.run();
    expect(item.status).toBe("succeeded");
    expect(slackBotOutcomeSchema.parse(outcome).agent?.status).toBe("failed");
  });

  test("a dry run still reads, but posts nothing and reports what it would reply", async () => {
    const t = setup({ script: [{ type: "final", tool: null, argsJson: null, text: "would say this" }], dry: true });
    await t.send(mention("UOK"));
    expect(t.posted).toEqual([]);
    expect(slackBotOutcomeSchema.parse(t.run().outcome)).toMatchObject({ dryRun: true, wouldReply: "would say this" });
  });

  test("secrets never appear in the logs, the outcome or the reply", async () => {
    const t = setup({
      script: [
        { type: "tool", tool: "linear.searchIssues", argsJson: '{"query":"token=abcdef0123456789secretvalue"}', text: null },
        { type: "final", tool: null, argsJson: null, text: "done" },
      ],
    });
    await t.send(mention("UOK"));
    const everything = JSON.stringify({ logs: t.logs, outcome: t.run().outcome, posted: t.posted });
    for (const secret of ["abcdef0123456789secretvalue", "lin_api_secretsecretsecret", SECRET_TOKEN]) expect(everything).not.toContain(secret);
  });
});

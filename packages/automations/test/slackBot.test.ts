import { createDispatcher, createSqliteActivityStore, createSqliteStore, withDryRun, type Event, type Logger } from "@automation-server/core";
import { describe, expect, test } from "bun:test";

import { createSlackBot, DENIED_REPLY, escapeSlackText } from "../src/slackBot/automation";
import type { PostMessage, SlackBotClient } from "../src/slackBot/client";
import { BUSY_REPLY, createSlackBotLimiter, RATE_LIMITED_REPLY, type SlackBotLimiter } from "../src/slackBot/limiter";

const mentionEvent = (user: string, patch: Record<string, unknown> = {}, externalId = "Ev1"): Event => ({
  project: "p",
  source: "slack",
  kind: "app_mention",
  externalId,
  receivedAt: "2026-01-01T00:00:00Z",
  payload: { team: "T1", channel: "C1", user, text: "create a ticket", ts: "100.1", threadTs: null, ...patch },
});

const setup = ({ allowedUsers = ["UOK"], dry = false, handler, limiter }: { allowedUsers?: string[]; dry?: boolean; handler?: (m: unknown) => Promise<string>; limiter?: SlackBotLimiter } = {}) => {
  const posted: PostMessage[] = [];
  const logs: string[] = [];
  const log: Logger = {
    info: (m, f) => void logs.push(JSON.stringify({ m, f })),
    warn: (m, f) => void logs.push(JSON.stringify({ m, f })),
    error: (m, f) => void logs.push(JSON.stringify({ m, f })),
  };
  const client: SlackBotClient = {
    authTest: async () => ({ botName: "b", botUserId: "UBOT", team: "t", teamId: "T1" }),
    replies: async () => [],
    postMessage: async (message) => {
      posted.push(message);
      return { ts: "200.1" };
    },
  };
  const bot = { ...createSlackBot({ client, allowedUsers, ...(handler ? { handler } : {}), ...(limiter ? { limiter } : {}) }), project: "p" };
  const activity = createSqliteActivityStore({ path: ":memory:" });
  const dispatcher = createDispatcher({
    automations: () => [dry ? withDryRun(bot) : bot],
    store: createSqliteStore({ path: ":memory:" }),
    log,
    activity,
  });
  const send = async (event: Event) => {
    dispatcher.enqueue(event);
    await dispatcher.drain(1000);
  };
  return { posted, logs, send, activity };
};

describe("slack-bot automation", () => {
  test("a listed user gets the F1 reply in the thread root", async () => {
    const t = setup();
    await t.send(mentionEvent("UOK"));
    expect(t.posted).toEqual([{ channel: "C1", threadTs: "100.1", text: "Got it: create a ticket" }]);
  });

  test("a reply inside a thread goes to the thread root", async () => {
    const t = setup();
    await t.send(mentionEvent("UOK", { threadTs: "50.5", ts: "100.1" }));
    expect(t.posted[0]!.threadTs).toBe("50.5");
  });

  test("an unlisted user gets exactly one denial and the handler never runs", async () => {
    let ran = 0;
    const t = setup({
      handler: async () => {
        ran += 1;
        return "secret work";
      },
    });
    await t.send(mentionEvent("UNOPE"));
    expect(t.posted).toEqual([{ channel: "C1", threadTs: "100.1", text: DENIED_REPLY }]);
    expect(ran).toBe(0);
  });

  test("an empty allowlist means nobody", async () => {
    const t = setup({ allowedUsers: [] });
    await t.send(mentionEvent("UOK"));
    expect(t.posted.map((p) => p.text)).toEqual([DENIED_REPLY]);
  });

  test("the same event twice replies once because the claim dedupes the retry", async () => {
    const t = setup();
    await t.send(mentionEvent("UOK"));
    await t.send(mentionEvent("UOK"));
    expect(t.posted).toHaveLength(1);
    const runs = t.activity.queryRuns({ limit: 10 }).items.map((r) => r.status).sort();
    expect(runs).toEqual(["duplicate", "succeeded"]);
  });

  test("text from the message cannot ping: markup is escaped", async () => {
    const t = setup();
    await t.send(mentionEvent("UOK", { text: "<!channel> hello <@U999> & <https://x.test|link>" }));
    const text = t.posted[0]!.text;
    expect(text).not.toContain("<!channel>");
    expect(text).not.toContain("<@U999>");
    expect(text).toBe("Got it: &lt;!channel&gt; hello &lt;@U999&gt; &amp; &lt;https://x.test|link&gt;");
    expect(escapeSlackText("<a>")).toBe("&lt;a&gt;");
  });

  test("an empty mention gets a readable reply", async () => {
    const t = setup();
    await t.send(mentionEvent("UOK", { text: "" }));
    expect(t.posted[0]!.text).toBe("Got it: (empty message)");
  });

  test("dry run posts nothing, logs what it would reply and reports it on the run", async () => {
    const t = setup({ dry: true });
    await t.send(mentionEvent("UOK"));
    expect(t.posted).toEqual([]);
    expect(t.logs.some((l) => l.includes("dry-run: would reply") && l.includes("Got it: create a ticket"))).toBe(true);
    const run = t.activity.queryRuns({ limit: 1 }).items[0]!;
    expect(run.dryRun).toBe(true);
    expect(t.activity.getRun(run.id)?.run.outcome).toMatchObject({ decision: "replied", dryRun: true, wouldReply: "Got it: create a ticket" });
  });

  test("dry run of a denied user also posts nothing", async () => {
    const t = setup({ dry: true });
    await t.send(mentionEvent("UNOPE"));
    expect(t.posted).toEqual([]);
  });

  test("a live run reports the decision on the run", async () => {
    const t = setup();
    await t.send(mentionEvent("UNOPE"));
    const run = t.activity.queryRuns({ limit: 1 }).items[0]!;
    expect(t.activity.getRun(run.id)?.run.outcome).toMatchObject({ decision: "denied", user: "UNOPE", replyTs: "200.1" });
  });

  describe("limits", () => {
    const clock = { t: 5_000_000 };
    const limiter = () => createSlackBotLimiter({ now: () => clock.t, denialReply: DENIED_REPLY });

    test("the seventh quick request gets one slow-down notice and later ones get nothing", async () => {
      let ran = 0;
      const t = setup({ limiter: limiter(), handler: async () => (ran++, "ok") });
      for (let i = 0; i < 9; i++) await t.send(mentionEvent("UOK", {}, `Ev${i}`));
      expect(ran).toBe(6);
      expect(t.posted.map((p) => p.text)).toEqual([...Array(6).fill("ok"), RATE_LIMITED_REPLY]);
      const decisions = t.activity.queryRuns({ limit: 20 }).items.map((r) => t.activity.getRun(r.id)?.run.outcome).map((o) => (o as { decision: string }).decision);
      expect(decisions.filter((d) => d === "rate-limited")).toHaveLength(3);
    });

    test("an unlisted user is told once and then ignored", async () => {
      const t = setup({ limiter: limiter() });
      for (let i = 0; i < 4; i++) await t.send(mentionEvent("UNOPE", {}, `Ev${i}`));
      expect(t.posted.map((p) => p.text)).toEqual([DENIED_REPLY]);
    });

    test("a fifth concurrent mention gets the busy reply and the slots free up afterwards", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const t = setup({ allowedUsers: ["U1", "U2", "U3", "U4", "U5"], limiter: limiter(), handler: async () => (await gate, "ok") });
      const sends = ["U1", "U2", "U3", "U4", "U5"].map((u, i) => t.send(mentionEvent(u, {}, `Ev${i}`)));
      await Bun.sleep(20);
      expect(t.posted.map((p) => p.text)).toEqual([BUSY_REPLY]);
      release();
      await Promise.all(sends);
      await t.send(mentionEvent("U5", {}, "Ev9"));
      expect(t.posted.map((p) => p.text).filter((x) => x === "ok")).toHaveLength(5);
    });

    test("a handler that throws frees its slot", async () => {
      const t = setup({ limiter: limiter(), handler: async () => Promise.reject(new Error("boom")) });
      for (let i = 0; i < 5; i++) await t.send(mentionEvent("UOK", {}, `Ev${i}`));
      const run = t.activity.queryRuns({ limit: 1 }).items[0]!;
      expect(run.status).toBe("failed");
      await t.send(mentionEvent("UOK", {}, "Ev9"));
      expect(t.posted).toEqual([]);
    });

    test("a dry run spends no quota", async () => {
      const shared = limiter();
      const dry = setup({ dry: true, limiter: shared });
      for (let i = 0; i < 10; i++) await dry.send(mentionEvent("UOK", {}, `Ev${i}`));
      const live = setup({ limiter: shared });
      await live.send(mentionEvent("UOK", {}, "Ev100"));
      expect(live.posted.map((p) => p.text)).toEqual(["Got it: create a ticket"]);
    });
  });

  test("a failed post fails the run and releases the claim so Slack's retry can reply", async () => {
    let fail = true;
    const posted: string[] = [];
    const client: SlackBotClient = {
      authTest: async () => ({ botName: "b", botUserId: "u", team: "t", teamId: "T" }),
      replies: async () => [],
      postMessage: async ({ text }) => {
        if (fail) throw new Error("ratelimited");
        posted.push(text);
        return { ts: "1" };
      },
    };
    const log: Logger = { info() {}, warn() {}, error() {} };
    const bot = { ...createSlackBot({ client, allowedUsers: ["UOK"] }), project: "p" };
    const dispatcher = createDispatcher({ automations: () => [bot], store: createSqliteStore({ path: ":memory:" }), log });
    dispatcher.enqueue(mentionEvent("UOK"));
    await dispatcher.drain(1000);
    fail = false;
    dispatcher.enqueue(mentionEvent("UOK"));
    await dispatcher.drain(1000);
    expect(posted).toEqual(["Got it: create a ticket"]);
  });
});

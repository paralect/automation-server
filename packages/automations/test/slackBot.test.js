import { createDispatcher, createSqliteActivityStore, createSqliteStore, withDryRun } from "@automation-server/core";
import { slackBotOutcomeSchema } from "@automation-server/sources/slack/outcome";
import { describe, expect, test } from "bun:test";
import { createSlackBot, DENIED_REPLY } from "../src/slackBot/automation";
import { escapeSlackText } from "../src/slackBot/client";
import { BUSY_REPLY, createSlackBotLimiter, RATE_LIMITED_REPLY } from "../src/slackBot/limiter";
const mentionEvent = (user, patch = {}, externalId = "Ev1") => ({
    project: "p",
    source: "slack",
    kind: "app_mention",
    externalId,
    receivedAt: "2026-01-01T00:00:00Z",
    payload: { team: "T1", channel: "C1", user, text: "create a ticket", ts: "100.1", threadTs: null, ...patch },
});
const setup = ({ allowedUsers = ["UOK"], allowedChannels, dry = false, handler, limiter } = {}) => {
    const posted = [];
    const logs = [];
    const log = {
        info: (m, f) => void logs.push(JSON.stringify({ m, f })),
        warn: (m, f) => void logs.push(JSON.stringify({ m, f })),
        error: (m, f) => void logs.push(JSON.stringify({ m, f })),
    };
    const client = {
        authTest: async () => ({ botName: "b", botUserId: "UBOT", team: "t", teamId: "T1" }),
        replies: async () => [],
        postMessage: async (message) => {
            posted.push(message);
            return { ts: "200.1" };
        },
    };
    const bot = { ...createSlackBot({ client, allowedUsers, ...(allowedChannels ? { allowedChannels } : {}), ...(handler ? { handler } : {}), ...(limiter ? { limiter } : {}) }), project: "p" };
    const activity = createSqliteActivityStore({ path: ":memory:" });
    const dispatcher = createDispatcher({
        automations: () => [dry ? withDryRun(bot) : bot],
        store: createSqliteStore({ path: ":memory:" }),
        log,
        activity,
    });
    const send = async (event) => {
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
        expect(t.posted[0].threadTs).toBe("50.5");
    });
    test("an unlisted user gets exactly one denial and the handler never runs", async () => {
        let ran = 0;
        const t = setup({
            handler: async () => {
                ran += 1;
                return { reply: "secret work" };
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
        const text = t.posted[0].text;
        expect(text).not.toContain("<!channel>");
        expect(text).not.toContain("<@U999>");
        expect(text).toBe("Got it: &lt;!channel&gt; hello &lt;@U999&gt; &amp; &lt;https://x.test|link&gt;");
        expect(escapeSlackText("<a>")).toBe("&lt;a&gt;");
    });
    test("an empty mention gets a readable reply", async () => {
        const t = setup();
        await t.send(mentionEvent("UOK", { text: "" }));
        expect(t.posted[0].text).toBe("Got it: (empty message)");
    });
    test("dry run posts nothing, logs what it would reply and reports it on the run", async () => {
        const t = setup({ dry: true });
        await t.send(mentionEvent("UOK"));
        expect(t.posted).toEqual([]);
        expect(t.logs.some((l) => l.includes("dry-run: would reply") && l.includes("Got it: create a ticket"))).toBe(true);
        const run = t.activity.queryRuns({ limit: 1 }).items[0];
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
        const run = t.activity.queryRuns({ limit: 1 }).items[0];
        expect(t.activity.getRun(run.id)?.run.outcome).toMatchObject({ decision: "denied", user: "UNOPE", replyTs: "200.1" });
    });
    describe("allowed channels", () => {
        const counting = () => {
            const seen = [];
            const handler = async ({ event }) => (seen.push(event.payload.text), { reply: "ok" });
            return { seen, handler };
        };
        const outcomes = (t) => t.activity.queryRuns({ limit: 20 }).items.map((r) => t.activity.getRun(r.id)?.run.outcome);
        test("an empty list answers in any channel", async () => {
            const t = setup({ allowedChannels: [] });
            await t.send(mentionEvent("UOK", { channel: "CANY" }));
            expect(t.posted.map((p) => p.channel)).toEqual(["CANY"]);
        });
        test("a listed channel is answered and any other is ignored without a word", async () => {
            const { seen, handler } = counting();
            const t = setup({ allowedChannels: ["CGOOD"], handler });
            await t.send(mentionEvent("UOK", { channel: "CGOOD" }, "Ev1"));
            await t.send(mentionEvent("UOK", { channel: "CELSE" }, "Ev2"));
            expect(t.posted.map((p) => p.channel)).toEqual(["CGOOD"]);
            expect(seen).toHaveLength(1);
        });
        test("an ignored mention is recorded as a decision on a succeeded run and posts nothing", async () => {
            const t = setup({ allowedChannels: ["CGOOD"] });
            await t.send(mentionEvent("UOK", { channel: "CELSE" }));
            expect(t.posted).toEqual([]);
            const run = t.activity.queryRuns({ limit: 1 }).items[0];
            expect(run.status).toBe("succeeded");
            const outcome = slackBotOutcomeSchema.parse(t.activity.getRun(run.id)?.run.outcome);
            expect(outcome).toMatchObject({ decision: "channel-not-allowed", channel: "CELSE", user: "UOK" });
            expect(outcome.replyTs).toBeUndefined();
            expect(t.logs.some((l) => l.includes("ignored: channel not allowed"))).toBe(true);
        });
        test("a user who is not allowed still gets the denial in an allowed channel, and nothing in another one", async () => {
            const t = setup({ allowedChannels: ["CGOOD"] });
            await t.send(mentionEvent("UNOPE", { channel: "CGOOD" }, "Ev1"));
            await t.send(mentionEvent("UNOPE", { channel: "CELSE" }, "Ev2"));
            expect(t.posted).toEqual([{ channel: "CGOOD", threadTs: "100.1", text: DENIED_REPLY }]);
        });
        test("approve and cancel from another channel never reach the handler", async () => {
            const { seen, handler } = counting();
            const t = setup({ allowedChannels: ["CGOOD"], handler });
            await t.send(mentionEvent("UOK", { channel: "CELSE", text: "approve", threadTs: "50.5" }, "Ev1"));
            await t.send(mentionEvent("UOK", { channel: "CELSE", text: "cancel", threadTs: "50.5" }, "Ev2"));
            expect(seen).toEqual([]);
            expect(t.posted).toEqual([]);
        });
        test("approve from a user who is not allowed does not reach the handler either", async () => {
            const { seen, handler } = counting();
            const t = setup({ allowedChannels: ["CGOOD"], handler });
            await t.send(mentionEvent("UNOPE", { channel: "CGOOD", text: "approve", threadTs: "50.5" }));
            expect(seen).toEqual([]);
            expect(t.posted.map((p) => p.text)).toEqual([DENIED_REPLY]);
        });
        test("approve in an allowed channel from an allowed user reaches the handler", async () => {
            const { seen, handler } = counting();
            const t = setup({ allowedChannels: ["CGOOD"], handler });
            await t.send(mentionEvent("UOK", { channel: "CGOOD", text: "approve", threadTs: "50.5" }));
            expect(seen).toEqual(["approve"]);
        });
        test("an ignored channel spends no quota, so it cannot starve the allowed one", async () => {
            const limiter = createSlackBotLimiter({ now: () => 9_000_000, denialReply: DENIED_REPLY });
            const t = setup({ allowedChannels: ["CGOOD"], limiter });
            for (let i = 0; i < 12; i++)
                await t.send(mentionEvent("UOK", { channel: "CELSE" }, `Ev${i}`));
            await t.send(mentionEvent("UOK", { channel: "CGOOD" }, "Ev99"));
            expect(t.posted.map((p) => p.text)).toEqual(["Got it: create a ticket"]);
            expect(outcomes(t).filter((o) => o.decision === "channel-not-allowed")).toHaveLength(12);
        });
        test("a dry run of an ignored mention reports the decision as a dry run", async () => {
            const t = setup({ allowedChannels: ["CGOOD"], dry: true });
            await t.send(mentionEvent("UOK", { channel: "CELSE" }));
            const run = t.activity.queryRuns({ limit: 1 }).items[0];
            expect(t.activity.getRun(run.id)?.run.outcome).toMatchObject({ decision: "channel-not-allowed", dryRun: true });
        });
    });
    describe("limits", () => {
        const clock = { t: 5_000_000 };
        const limiter = () => createSlackBotLimiter({ now: () => clock.t, denialReply: DENIED_REPLY });
        test("the seventh quick request gets one slow-down notice and later ones get nothing", async () => {
            let ran = 0;
            const t = setup({ limiter: limiter(), handler: async () => (ran++, { reply: "ok" }) });
            for (let i = 0; i < 9; i++)
                await t.send(mentionEvent("UOK", {}, `Ev${i}`));
            expect(ran).toBe(6);
            expect(t.posted.map((p) => p.text)).toEqual([...Array(6).fill("ok"), RATE_LIMITED_REPLY]);
            const decisions = t.activity.queryRuns({ limit: 20 }).items.map((r) => t.activity.getRun(r.id)?.run.outcome).map((o) => o.decision);
            expect(decisions.filter((d) => d === "rate-limited")).toHaveLength(3);
        });
        test("an unlisted user is told once and then ignored", async () => {
            const t = setup({ limiter: limiter() });
            for (let i = 0; i < 4; i++)
                await t.send(mentionEvent("UNOPE", {}, `Ev${i}`));
            expect(t.posted.map((p) => p.text)).toEqual([DENIED_REPLY]);
        });
        test("a fifth concurrent mention gets the busy reply and the slots free up afterwards", async () => {
            let release;
            const gate = new Promise((r) => (release = r));
            const t = setup({ allowedUsers: ["U1", "U2", "U3", "U4", "U5"], limiter: limiter(), handler: async () => (await gate, { reply: "ok" }) });
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
            for (let i = 0; i < 5; i++)
                await t.send(mentionEvent("UOK", {}, `Ev${i}`));
            await t.send(mentionEvent("UOK", {}, "Ev9"));
            expect(t.posted.every((p) => p.text.startsWith("I could not do that: "))).toBe(true);
            expect(t.posted).toHaveLength(6);
        });
        test("a dry run spends no quota", async () => {
            const shared = limiter();
            const dry = setup({ dry: true, limiter: shared });
            for (let i = 0; i < 10; i++)
                await dry.send(mentionEvent("UOK", {}, `Ev${i}`));
            const live = setup({ limiter: shared });
            await live.send(mentionEvent("UOK", {}, "Ev100"));
            expect(live.posted.map((p) => p.text)).toEqual(["Got it: create a ticket"]);
        });
    });
    test("the handler gets the event, the run context, the client and the settings", async () => {
        let seen;
        const t = setup({
            handler: async (input) => {
                seen = input;
                return { reply: "ok" };
            },
        });
        await t.send(mentionEvent("UOK"));
        expect(seen.event.payload.text).toBe("create a ticket");
        expect(seen.config.allowedUsers).toEqual(["UOK"]);
        expect(typeof seen.client.postMessage).toBe("function");
        expect(typeof seen.ctx.log.info).toBe("function");
    });
    test("steps from the handler are logged one by one and summarised in a compact outcome", async () => {
        const t = setup({
            handler: async () => ({
                reply: "done",
                status: "answered",
                steps: [
                    { index: 1, tool: "linear.searchIssues", args: '{"query":"billing"}', ok: true, durationMs: 12 },
                    { index: 2, tool: "linear.getIssue", args: '{"identifier":"ENG-1"}', ok: false, durationMs: 3, error: "not found" },
                ],
            }),
        });
        await t.send(mentionEvent("UOK"));
        const stepLogs = t.logs.filter((l) => l.includes("agent step"));
        expect(stepLogs).toHaveLength(2);
        expect(stepLogs[0]).toContain("linear.searchIssues");
        const run = t.activity.queryRuns({ limit: 1 }).items[0];
        const outcome = slackBotOutcomeSchema.parse(t.activity.getRun(run.id)?.run.outcome);
        expect(outcome.agent).toEqual({
            status: "answered",
            stepCount: 2,
            toolsUsed: ["linear.searchIssues", "linear.getIssue"],
            steps: [
                { tool: "linear.searchIssues", ok: true, durationMs: 12 },
                { tool: "linear.getIssue", ok: false, durationMs: 3 },
            ],
        });
    });
    test("a handler that throws still answers in the thread and the run succeeds, with the reason scrubbed", async () => {
        const t = setup({
            handler: async () => {
                throw new Error("model down, token=hunter2hunter2 <!channel>");
            },
        });
        await t.send(mentionEvent("UOK"));
        expect(t.posted).toHaveLength(1);
        const text = t.posted[0].text;
        expect(text.startsWith("I could not do that: ")).toBe(true);
        expect(text).not.toContain("hunter2");
        expect(text).not.toContain("<!channel>");
        const run = t.activity.queryRuns({ limit: 1 }).items[0];
        expect(run.status).toBe("succeeded");
    });
    test("a failed post fails the run and releases the claim so Slack's retry can reply", async () => {
        let fail = true;
        const posted = [];
        const client = {
            authTest: async () => ({ botName: "b", botUserId: "u", team: "t", teamId: "T" }),
            replies: async () => [],
            postMessage: async ({ text }) => {
                if (fail)
                    throw new Error("ratelimited");
                posted.push(text);
                return { ts: "1" };
            },
        };
        const log = { info() { }, warn() { }, error() { } };
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

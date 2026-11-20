import { describe, expect, test } from "bun:test";
import { createScheduler } from "../src/scheduler";
import { createSqliteActivityStore } from "../src/sqliteActivityStore";
import { createSqliteStore } from "../src/sqliteStore";
const quiet = { info() { }, warn() { }, error() { } };
const setup = (jobs, startAt = "2026-02-16T09:00:00Z") => {
    const clock = { now: new Date(startAt) };
    const activity = createSqliteActivityStore({ path: ":memory:" });
    const scheduler = createScheduler({
        jobs: () => jobs,
        store: createSqliteStore({ path: ":memory:" }),
        log: quiet,
        activity,
        now: () => clock.now,
    });
    const advance = (ms) => (clock.now = new Date(clock.now.getTime() + ms));
    const runs = () => activity.queryRuns({ limit: 50 }).items;
    return { scheduler, activity, clock, advance, runs };
};
const weekly = (name, due, run = async () => { }) => ({ name, due, run });
describe("scheduler", () => {
    test("runs a job only when due and records a schedule run", async () => {
        const seen = [];
        const { scheduler, advance, runs } = setup([
            weekly("report", (now) => (now.getUTCHours() === 10 ? "2026-W08" : null), async ({ key }) => void seen.push(key)),
        ]);
        await scheduler.tick();
        expect(seen).toEqual([]);
        advance(3_600_000);
        await scheduler.tick();
        expect(seen).toEqual(["2026-W08"]);
        expect(runs()).toHaveLength(1);
        expect(runs()[0]).toMatchObject({ automation: "report", source: "schedule", kind: "job", externalId: "2026-W08", status: "succeeded" });
    });
    test("ticking again inside the same occurrence does not rerun or record duplicates", async () => {
        let count = 0;
        const { scheduler, advance, runs } = setup([weekly("report", () => "2026-W08", async () => void count++)]);
        for (let i = 0; i < 5; i++) {
            await scheduler.tick();
            advance(60_000);
        }
        expect(count).toBe(1);
        expect(runs()).toHaveLength(1);
    });
    test("a new key is a new occurrence", async () => {
        const keys = [];
        let week = "2026-W08";
        const { scheduler } = setup([weekly("report", () => week, async ({ key }) => void keys.push(key))]);
        await scheduler.tick();
        week = "2026-W09";
        await scheduler.tick();
        expect(keys).toEqual(["2026-W08", "2026-W09"]);
    });
    test("a restart in the same occurrence does not resend, because the claim lives in the store", async () => {
        const store = createSqliteStore({ path: ":memory:" });
        let count = 0;
        const job = weekly("report", () => "2026-W08", async () => void count++);
        const make = () => createScheduler({ jobs: () => [job], store, log: quiet });
        await make().tick();
        await make().tick();
        expect(count).toBe(1);
    });
    test("a failed run is recorded as failed and is not retried within the occurrence", async () => {
        let count = 0;
        const { scheduler, runs } = setup([
            weekly("report", () => "2026-W08", async () => {
                count++;
                throw new Error("posthog 500");
            }),
        ]);
        await scheduler.tick();
        await scheduler.tick();
        expect(count).toBe(1);
        expect(runs()[0]).toMatchObject({ status: "failed", error: "posthog 500" });
    });
    test("one job throwing in due or run does not stop the others", async () => {
        let ran = 0;
        const { scheduler } = setup([
            weekly("bad-due", () => {
                throw new Error("boom");
            }),
            weekly("bad-run", () => "k", async () => {
                throw new Error("boom");
            }),
            weekly("good", () => "k", async () => void ran++),
        ]);
        await scheduler.tick();
        expect(ran).toBe(1);
    });
    test("a job still running is not started again by the next tick", async () => {
        let release;
        let starts = 0;
        let key = "a";
        const { scheduler } = setup([
            weekly("slow", () => key, async () => {
                starts++;
                await new Promise((r) => (release = r));
            }),
        ]);
        const first = scheduler.tick();
        key = "b";
        await scheduler.tick();
        expect(starts).toBe(1);
        release();
        await first;
    });
    test("runNow bypasses due, dedupes by key and reports unknown jobs", async () => {
        let count = 0;
        const { scheduler, runs } = setup([weekly("report", () => null, async () => void count++)]);
        expect(await scheduler.runNow("report", "manual:1")).toMatchObject({ status: "succeeded" });
        expect(await scheduler.runNow("report", "manual:1")).toEqual({ status: "duplicate" });
        expect(await scheduler.runNow("report", "manual:2")).toMatchObject({ status: "succeeded" });
        expect(await scheduler.runNow("nope", "manual:1")).toEqual({ status: "unknown-job" });
        expect(count).toBe(2);
        expect(runs()).toHaveLength(2);
    });
    test("runNow calls onStarted with the run id while the job is still running and stores replayOf", async () => {
        let release;
        const { scheduler, activity } = setup([weekly("report", () => null, () => new Promise((r) => (release = r)))]);
        const started = new Promise((resolve) => {
            void scheduler.runNow("report", "replay:1", { replayOf: "orig", onStarted: resolve });
        });
        const runId = await started;
        expect(activity.getRun(runId)?.run).toMatchObject({ status: "running", replayOf: "orig" });
        release();
    });
    test("runNow runs an unregistered job object and reports its run id and failure", async () => {
        const { scheduler, runs } = setup([]);
        const failing = weekly("off-schedule", () => null, async () => {
            throw new Error("upstream down");
        });
        const result = await scheduler.runNow(failing, "manual:1");
        expect(result).toMatchObject({ status: "failed", error: "upstream down" });
        expect(runs()[0]).toMatchObject({ id: "runId" in result ? result.runId : "", automation: "off-schedule", status: "failed" });
    });
    test("the job list is read on every tick so a reload takes effect", async () => {
        const jobs = [];
        const clock = new Date("2026-02-16T09:00:00Z");
        const scheduler = createScheduler({ jobs: () => jobs, store: createSqliteStore({ path: ":memory:" }), log: quiet, now: () => clock });
        let count = 0;
        await scheduler.tick();
        jobs.push(weekly("late", () => "k", async () => void count++));
        await scheduler.tick();
        expect(count).toBe(1);
    });
    test("drain waits for a running job and gives up at the timeout", async () => {
        let release;
        const { scheduler } = setup([weekly("slow", () => "k", () => new Promise((r) => (release = r)))]);
        void scheduler.tick();
        const started = Date.now();
        await scheduler.drain(50);
        expect(Date.now() - started).toBeLessThan(500);
        release();
        await scheduler.drain(1000);
    });
});
describe("scheduler failures outside the job", () => {
    const recording = () => {
        const errors = [];
        const log = { info() { }, warn() { }, error: (message, fields) => void errors.push({ message, error: fields?.error }) };
        return { log, errors };
    };
    const failingComplete = () => ({ ...createSqliteStore({ path: ":memory:" }), complete: () => {
            throw new Error("disk full");
        } });
    test("a claim store that fails to complete keeps a successful run succeeded", async () => {
        const { log, errors } = recording();
        const activity = createSqliteActivityStore({ path: ":memory:" });
        const scheduler = createScheduler({ jobs: () => [], store: failingComplete(), log, activity });
        const result = await scheduler.runNow(weekly("report", () => null), "manual:1");
        expect(result).toMatchObject({ status: "succeeded" });
        expect(activity.queryRuns({ limit: 10 }).items.map((r) => r.status)).toEqual(["succeeded"]);
        expect(errors.map((e) => e.error)).toEqual(["disk full"]);
    });
    test("a claim store that fails to complete does not hide why the job failed", async () => {
        const { log, errors } = recording();
        const activity = createSqliteActivityStore({ path: ":memory:" });
        const scheduler = createScheduler({ jobs: () => [], store: failingComplete(), log, activity });
        const failing = weekly("report", () => null, async () => {
            throw new Error("posthog 500");
        });
        expect(await scheduler.runNow(failing, "manual:1")).toMatchObject({ status: "failed", error: "posthog 500" });
        expect(activity.queryRuns({ limit: 10 }).items[0]).toMatchObject({ status: "failed", error: "posthog 500" });
        expect(errors.map((e) => e.error).sort()).toEqual(["disk full", "posthog 500"]);
    });
    test("a job list that throws is logged by every tick, including the one start fires, without an unhandled rejection", async () => {
        const rejections = [];
        const listener = (reason) => void rejections.push(reason);
        process.on("unhandledRejection", listener);
        const { log, errors } = recording();
        const scheduler = createScheduler({
            jobs: () => {
                throw new Error("registry broken");
            },
            store: createSqliteStore({ path: ":memory:" }),
            log,
        });
        try {
            scheduler.start();
            await scheduler.tick();
            await Bun.sleep(10);
        }
        finally {
            scheduler.stop();
            process.off("unhandledRejection", listener);
        }
        expect(rejections).toEqual([]);
        expect(errors.map((e) => e.error)).toEqual(["registry broken", "registry broken"]);
    });
});
describe("scheduler onRunFinished", () => {
    const withHandler = (job, onRunFinished) => {
        const warnings = [];
        const log = { info() { }, warn: (m) => void warnings.push(m), error() { } };
        const scheduler = createScheduler({
            jobs: () => [job],
            store: createSqliteStore({ path: ":memory:" }),
            log,
            activity: createSqliteActivityStore({ path: ":memory:" }),
            onRunFinished,
        });
        return { scheduler, warnings };
    };
    test("is called for succeeded and failed job runs and drain waits for it", async () => {
        const seen = [];
        let slowDone = false;
        const job = weekly("report", () => null, async ({ key }) => {
            if (key === "bad")
                throw new Error("job broke");
        });
        const { scheduler } = withHandler(job, async (run) => {
            await new Promise((r) => setTimeout(r, 20));
            seen.push(`${run.status}:${run.externalId}`);
            slowDone = true;
        });
        await scheduler.runNow(job, "good");
        await scheduler.runNow(job, "bad");
        expect(seen).toEqual(["succeeded:good", "failed:bad"]);
        expect(slowDone).toBe(true);
    });
    test("a throwing handler is swallowed and does not change the run result", async () => {
        const job = weekly("report", () => null);
        const { scheduler, warnings } = withHandler(job, () => {
            throw new Error("handler broke");
        });
        expect(await scheduler.runNow(job, "k")).toMatchObject({ status: "succeeded" });
        expect(warnings).toEqual(["onRunFinished failed"]);
    });
    test("is not called for a duplicate occurrence", async () => {
        let calls = 0;
        const job = weekly("report", () => null);
        const { scheduler } = withHandler(job, () => void calls++);
        await scheduler.runNow(job, "k");
        expect(await scheduler.runNow(job, "k")).toEqual({ status: "duplicate" });
        expect(calls).toBe(1);
    });
});

import { describe, expect, test } from "bun:test";

import { BUSY_REPLY, createSlackBotLimiter, RATE_LIMITED_REPLY, type Admission } from "../src/slackBot/limiter";

const DENIAL = "not allowed";

const setup = (maxTracked?: number) => {
  const clock = { t: 1_000_000 };
  const limiter = createSlackBotLimiter({ now: () => clock.t, denialReply: DENIAL, ...(maxTracked ? { maxTracked } : {}) });
  const admit = (user: string, allowed = true, project = "p") => limiter.admit({ project, user, allowed });
  const run = (user: string, project = "p"): Extract<Admission, { kind: "run" }> => {
    const a = admit(user, true, project);
    if (a.kind !== "run") throw new Error(`expected run, got ${a.kind}`);
    return a;
  };
  return { clock, admit, run };
};

describe("allowed users", () => {
  test("six requests a minute run, the seventh is dropped with one notice", () => {
    const { admit, run } = setup();
    for (let i = 0; i < 6; i++) run("U1").release();
    expect(admit("U1")).toEqual({ kind: "rate-limited", reply: RATE_LIMITED_REPLY });
    expect(admit("U1")).toEqual({ kind: "rate-limited", reply: null });
    expect(admit("U1")).toEqual({ kind: "rate-limited", reply: null });
  });

  test("tokens refill over time, one every ten seconds", () => {
    const { admit, run, clock } = setup();
    for (let i = 0; i < 6; i++) run("U1").release();
    expect(admit("U1").kind).toBe("rate-limited");
    clock.t += 9_000;
    expect(admit("U1").kind).toBe("rate-limited");
    clock.t += 1_000;
    run("U1").release();
    expect(admit("U1").kind).toBe("rate-limited");
  });

  test("a full minute restores the whole bucket and the notice is allowed again", () => {
    const { admit, run, clock } = setup();
    for (let i = 0; i < 6; i++) run("U1").release();
    expect(admit("U1")).toMatchObject({ reply: RATE_LIMITED_REPLY });
    clock.t += 60_000;
    for (let i = 0; i < 6; i++) run("U1").release();
    expect(admit("U1")).toMatchObject({ kind: "rate-limited", reply: RATE_LIMITED_REPLY });
  });

  test("users and projects have separate buckets", () => {
    const { admit, run } = setup();
    for (let i = 0; i < 6; i++) run("U1").release();
    expect(admit("U1").kind).toBe("rate-limited");
    expect(run("U2").kind).toBe("run");
    expect(run("U1", "other").kind).toBe("run");
  });

  test("normal use is never limited", () => {
    const { run, clock } = setup();
    for (let i = 0; i < 100; i++) {
      run("U1").release();
      clock.t += 15_000;
    }
  });
});

describe("users who are not allowed", () => {
  test("get the denial once per ten minutes and are silent in between", () => {
    const { admit, clock } = setup();
    expect(admit("UX", false)).toEqual({ kind: "denied", reply: DENIAL });
    expect(admit("UX", false)).toEqual({ kind: "denied", reply: null });
    clock.t += 9 * 60_000;
    expect(admit("UX", false)).toEqual({ kind: "denied", reply: null });
    clock.t += 60_000;
    expect(admit("UX", false)).toEqual({ kind: "denied", reply: DENIAL });
  });

  test("each user has their own window and a denial never spends a slot", () => {
    const { admit, run } = setup();
    expect(admit("UX", false).kind).toBe("denied");
    expect(admit("UY", false)).toEqual({ kind: "denied", reply: DENIAL });
    for (let i = 0; i < 6; i++) run("U1").release();
  });
});

describe("in-flight cap", () => {
  test("a fifth concurrent run gets one busy notice per user per minute", () => {
    const { admit, run, clock } = setup();
    const slots = ["A", "B", "C", "D"].map((u) => run(u));
    expect(admit("E")).toEqual({ kind: "busy", reply: BUSY_REPLY });
    expect(admit("E")).toEqual({ kind: "busy", reply: null });
    expect(admit("F")).toEqual({ kind: "busy", reply: BUSY_REPLY });
    clock.t += 60_000;
    expect(admit("E")).toEqual({ kind: "busy", reply: BUSY_REPLY });
    slots[0]!.release();
    expect(run("E").kind).toBe("run");
  });

  test("the cap is per project and a slot is released once even when released twice", () => {
    const { admit, run } = setup();
    const slots = ["A", "B", "C", "D"].map((u) => run(u));
    expect(run("A", "other").kind).toBe("run");
    slots[0]!.release();
    slots[0]!.release();
    expect(run("E").kind).toBe("run");
    expect(admit("G").kind).toBe("busy");
  });

  test("a busy answer does not spend the asker's tokens", () => {
    const { admit, run } = setup();
    const slots = ["A", "B", "C", "D"].map((u) => run(u));
    for (let i = 0; i < 20; i++) expect(admit("E").kind).toBe("busy");
    for (const s of slots) s.release();
    for (let i = 0; i < 6; i++) run("E").release();
  });
});

describe("bounded memory", () => {
  test("old entries are evicted when more users than the bound show up", () => {
    const { admit, clock } = setup(3);
    expect(admit("U1", false)).toMatchObject({ reply: DENIAL });
    expect(admit("U1", false)).toMatchObject({ reply: null });
    for (const u of ["U2", "U3", "U4", "U5"]) admit(u, false);
    expect(admit("U1", false)).toMatchObject({ reply: DENIAL });
    expect(admit("U5", false)).toMatchObject({ reply: null });
    clock.t += 1;
  });

  test("a flood of distinct users does not slow admission down", () => {
    const { admit } = setup(100);
    const started = performance.now();
    for (let i = 0; i < 20_000; i++) admit(`U${i}`, i % 2 === 0);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canTransition, TRANSITIONS } from "../src/pendingActions";
import { createSqlitePendingActionStore } from "../src/sqlitePendingActionStore";
import { createSqliteStore } from "../src/sqliteStore";
const open = [];
const track = (s) => (open.push(s), s);
afterEach(() => {
    while (open.length)
        open.pop().close();
});
const action = (patch = {}) => ({
    project: "p",
    team: "T1",
    channel: "C1",
    threadTs: "100.1",
    requestedBy: "U1",
    tool: "linear.createIssue",
    args: { title: "Fix billing" },
    expiresAt: 1_000,
    ...patch,
});
describe("pending action state machine", () => {
    test("only the listed transitions are allowed", () => {
        expect(canTransition("pending", "approved")).toBe(true);
        expect(canTransition("approved", "executed")).toBe(true);
        expect(canTransition("pending", "executed")).toBe(false);
        expect(canTransition("executed", "pending")).toBe(false);
        expect(canTransition("cancelled", "approved")).toBe(false);
        for (const [from, tos] of Object.entries(TRANSITIONS)) {
            expect(tos.includes(from)).toBe(false);
        }
    });
});
describe("sqlite pending action store", () => {
    test("create stores the validated args and finds the pending action by thread", () => {
        const s = track(createSqlitePendingActionStore({ path: ":memory:", now: () => 5 }));
        const created = s.create(action());
        expect(created).toMatchObject({ status: "pending", createdAt: 5, args: { title: "Fix billing" }, requestedBy: "U1" });
        expect(s.findPendingForThread("p", "C1", "100.1")?.id).toBe(created.id);
        expect(s.get(created.id)).toEqual(created);
    });
    test("a pending action is never found for another thread, channel or project", () => {
        const s = track(createSqlitePendingActionStore({ path: ":memory:" }));
        s.create(action());
        expect(s.findPendingForThread("p", "C1", "999.9")).toBeNull();
        expect(s.findPendingForThread("p", "C2", "100.1")).toBeNull();
        expect(s.findPendingForThread("q", "C1", "100.1")).toBeNull();
    });
    test("a new proposal in the same thread cancels the old one", () => {
        let t = 0;
        const s = track(createSqlitePendingActionStore({ path: ":memory:", now: () => ++t }));
        const first = s.create(action());
        const second = s.create(action({ args: { title: "Other" } }));
        expect(s.get(first.id)).toMatchObject({ status: "cancelled", resolvedAt: expect.any(Number) });
        expect(s.findPendingForThread("p", "C1", "100.1")?.id).toBe(second.id);
    });
    test("transition is a compare and set: the second approve loses", () => {
        const s = track(createSqlitePendingActionStore({ path: ":memory:" }));
        const { id } = s.create(action());
        expect(s.transition(id, "pending", "approved")).toBe(true);
        expect(s.transition(id, "pending", "approved")).toBe(false);
        expect(s.findPendingForThread("p", "C1", "100.1")).toBeNull();
        expect(s.transition(id, "approved", "executed", "Created ENG-1")).toBe(true);
        expect(s.get(id)).toMatchObject({ status: "executed", resultText: "Created ENG-1", resolvedAt: expect.any(Number) });
    });
    test("two concurrent approvals through separate connections let exactly one win", async () => {
        const dir = mkdtempSync(join(tmpdir(), "pending-"));
        try {
            const path = join(dir, "db.sqlite");
            const a = track(createSqlitePendingActionStore({ path }));
            const b = track(createSqlitePendingActionStore({ path }));
            const { id } = a.create(action());
            const results = await Promise.all([
                Promise.resolve().then(() => a.transition(id, "pending", "approved")),
                Promise.resolve().then(() => b.transition(id, "pending", "approved")),
            ]);
            expect(results.filter(Boolean)).toHaveLength(1);
        }
        finally {
            while (open.length)
                open.pop().close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
    test("a transition the table does not allow throws and changes nothing", () => {
        const s = track(createSqlitePendingActionStore({ path: ":memory:" }));
        const { id } = s.create(action());
        expect(() => s.transition(id, "pending", "executed")).toThrow();
        expect(s.get(id)?.status).toBe("pending");
    });
    test("expireOlderThan expires only pending actions that are due", () => {
        const s = track(createSqlitePendingActionStore({ path: ":memory:" }));
        const due = s.create(action({ threadTs: "1", expiresAt: 100 }));
        const later = s.create(action({ threadTs: "2", expiresAt: 500 }));
        const approved = s.create(action({ threadTs: "3", expiresAt: 100 }));
        s.transition(approved.id, "pending", "approved");
        expect(s.expireOlderThan(200)).toBe(1);
        expect(s.get(due.id)?.status).toBe("expired");
        expect(s.get(later.id)?.status).toBe("pending");
        expect(s.get(approved.id)?.status).toBe("approved");
        expect(s.expireOlderThan(200)).toBe(0);
    });
    test("prune deletes rows resolved or expired before the cutoff and keeps the rest", () => {
        let t = 100;
        const s = track(createSqlitePendingActionStore({ path: ":memory:", now: () => t }));
        const cancelledOld = s.create(action({ threadTs: "1", expiresAt: 10_000 }));
        s.transition(cancelledOld.id, "pending", "cancelled");
        const executedOld = s.create(action({ threadTs: "2", expiresAt: 10_000 }));
        s.transition(executedOld.id, "pending", "approved");
        s.transition(executedOld.id, "approved", "executed", "done");
        const stuckApproved = s.create(action({ threadTs: "3", expiresAt: 150 }));
        s.transition(stuckApproved.id, "pending", "approved");
        const expiredPending = s.create(action({ threadTs: "4", expiresAt: 120 }));
        t = 1_000;
        const cancelledNew = s.create(action({ threadTs: "5", expiresAt: 10_000 }));
        s.transition(cancelledNew.id, "pending", "cancelled");
        const livePending = s.create(action({ threadTs: "6", expiresAt: 10_000 }));
        expect(s.prune(new Date(500).toISOString())).toBe(4);
        for (const gone of [cancelledOld, executedOld, stuckApproved, expiredPending])
            expect(s.get(gone.id)).toBeNull();
        expect(s.get(cancelledNew.id)?.status).toBe("cancelled");
        expect(s.get(livePending.id)?.status).toBe("pending");
        expect(s.prune(new Date(500).toISOString())).toBe(0);
    });
    test("prune rejects a cutoff that is not a date", () => {
        const s = track(createSqlitePendingActionStore({ path: ":memory:" }));
        expect(() => s.prune("yesterday")).toThrow("invalid prune cutoff");
    });
    test("migrates a database that already holds other stores and keeps their data", () => {
        const dir = mkdtempSync(join(tmpdir(), "pending-"));
        try {
            const path = join(dir, "db.sqlite");
            const claims = createSqliteStore({ path });
            claims.claim("keep");
            claims.close();
            const s = createSqlitePendingActionStore({ path });
            const { id } = s.create(action());
            s.close();
            const again = createSqlitePendingActionStore({ path });
            expect(again.get(id)?.status).toBe("pending");
            again.close();
            const db = new Database(path);
            expect(db.query("SELECT version FROM schema_versions WHERE component = 'pending_actions'").get()).toEqual({ version: 1 });
            expect(db.query("SELECT key FROM claims").all()).toEqual([{ key: "keep" }]);
            db.close();
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

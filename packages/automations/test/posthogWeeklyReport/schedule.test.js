import { describe, expect, test } from "bun:test";
import { isDue, isoWeekKey } from "../../src/posthogWeeklyReport";
describe("isoWeekKey", () => {
    test.each([
        ["2026-02-16T09:00:00Z", "2026-W08"],
        ["2026-02-22T23:59:59Z", "2026-W08"],
        ["2026-01-01T00:00:00Z", "2026-W01"],
        ["2027-01-01T12:00:00Z", "2026-W53"],
        ["2024-12-30T00:00:00Z", "2025-W01"],
    ])("%s is %s", (at, key) => {
        expect(isoWeekKey(new Date(at))).toBe(key);
    });
});
describe("isDue", () => {
    test("is due from the configured weekday and UTC hour until the end of the ISO week", () => {
        expect(isDue(new Date("2026-02-16T08:59:59Z"), 1, 9)).toBeNull();
        expect(isDue(new Date("2026-02-16T09:00:00Z"), 1, 9)).toBe("2026-W08");
        expect(isDue(new Date("2026-02-18T03:00:00Z"), 1, 9)).toBe("2026-W08");
        expect(isDue(new Date("2026-02-22T23:00:00Z"), 1, 9)).toBe("2026-W08");
        expect(isDue(new Date("2026-02-23T08:00:00Z"), 1, 9)).toBeNull();
    });
    test("Sunday (0) is the last day of the ISO week", () => {
        expect(isDue(new Date("2026-02-21T12:00:00Z"), 0, 6)).toBeNull();
        expect(isDue(new Date("2026-02-22T05:59:00Z"), 0, 6)).toBeNull();
        expect(isDue(new Date("2026-02-22T06:00:00Z"), 0, 6)).toBe("2026-W08");
    });
    test("a later weekday is not due earlier in the week", () => {
        expect(isDue(new Date("2026-02-18T23:00:00Z"), 5, 0)).toBeNull();
        expect(isDue(new Date("2026-02-20T00:00:00Z"), 5, 0)).toBe("2026-W08");
    });
});

import { expect, test } from "bun:test";
import { createLogger } from "../src/logger";

test("createLogger writes JSON lines and merges base and call fields", () => {
  const lines: string[] = [];
  const log = createLogger({ service: "svc", shared: "base" }, (l) => lines.push(l));
  log.info("hello", { shared: "call", extra: 1 });
  log.error("bad");
  expect(lines).toHaveLength(2);
  const first = JSON.parse(lines[0]!);
  expect(first).toMatchObject({ level: "info", message: "hello", service: "svc", shared: "call", extra: 1 });
  expect(Number.isNaN(Date.parse(first.time))).toBe(false);
  expect(JSON.parse(lines[1]!)).toMatchObject({ level: "error", message: "bad", service: "svc", shared: "base" });
});

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PR_PRODUCERS, producerOfBranch } from "../src/producers";

const WORKFLOWS = join(import.meta.dir, "../../../github-actions");

describe("PR producers", () => {
  for (const producer of PR_PRODUCERS) {
    test(`${producer.workflowFile} exists and pushes ${producer.branchPrefix}*`, () => {
      const path = join(WORKFLOWS, producer.workflowFile);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toContain(`branch="${producer.branchPrefix}`);
    });
  }

  test("each branch maps to the workflow that pushes it, and other branches to none", () => {
    expect(producerOfBranch("codex/issue-12")).toBe("codex-issue-fix");
    expect(producerOfBranch("linear/eng-42")).toBe("linear-implement");
    expect(producerOfBranch("seo-autopilot/2026-11-20-1234")).toBe("codex-seo-autopilot");
    expect(producerOfBranch("changelog/abc1234")).toBe("codex-changelog");
    expect(producerOfBranch("feature/login")).toBeNull();
    expect(producerOfBranch("linear/")).toBeNull();
  });
});

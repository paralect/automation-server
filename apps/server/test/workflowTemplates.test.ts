import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { buildTemplates, WORKFLOW_TEMPLATES } from "@automation-server/api/workflowTemplates";

import { collectSources, generate, OUTPUT_FILE } from "../../../scripts/generate-workflow-templates";

const meta = { title: "T", description: "D", requiredSecrets: [], requiredVariables: [] };

describe("bundled workflow templates", () => {
  test("generated module matches github-actions/ (run `bun run generate:workflows` when this fails)", () => {
    expect(readFileSync(OUTPUT_FILE, "utf8")).toBe(generate());
  });

  test("every bundled workflow has metadata and becomes a template", () => {
    const workflows = Object.keys(collectSources()).filter((path) => !path.includes("/") && path.endsWith(".yml"));
    expect(workflows.length).toBeGreaterThan(0);
    expect(WORKFLOW_TEMPLATES.map((t) => t.path)).toEqual(workflows.sort().map((file) => `.github/workflows/${file}`));
  });

  test("a template ships its workflow first, then its skill under .agents/skills", () => {
    const issueFix = WORKFLOW_TEMPLATES.find((t) => t.id === "codex-issue-fix");
    expect(issueFix?.files.map((f) => f.path)).toEqual([
      ".github/workflows/codex-issue-fix.yml",
      ".agents/skills/fix-issue/SKILL.md",
      ".agents/skills/fix-issue/agents/openai.yaml",
      ".agents/skills/fix-issue/references/sentry.md",
    ]);
    expect(WORKFLOW_TEMPLATES.find((t) => t.id === "codex-seo-autopilot")?.files).toHaveLength(1);
  });

  test("a workflow file without metadata fails loudly", () => {
    expect(() => buildTemplates({ "new-thing.yml": "name: x" }, {})).toThrow("github-actions/new-thing.yml has no entry in TEMPLATE_META");
  });

  test("a template whose skill folder is missing fails loudly", () => {
    expect(() => buildTemplates({ "a.yml": "x" }, { "a.yml": { ...meta, skill: "gone" } })).toThrow("github-actions/skills/gone/ is empty");
  });

  test("metadata for a workflow not bundled yet is not offered", () => {
    expect(buildTemplates({}, { "a.yml": meta })).toEqual([]);
    const linear = buildTemplates({ "linear-implement.yml": "name: x", "skills/implement-task/SKILL.md": "s" });
    expect(linear.map((t) => [t.id, t.files.map((f) => f.path)])).toEqual([
      ["linear-implement", [".github/workflows/linear-implement.yml", ".agents/skills/implement-task/SKILL.md"]],
    ]);
  });
});

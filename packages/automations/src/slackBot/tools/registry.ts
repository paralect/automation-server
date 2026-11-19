import { redactUntrusted, singleLine, truncate } from "../../redact";
import type { AnyTool, ToolContext, ToolResult } from "./types";

export const MAX_TOOL_RESULT_CHARS = 4000;
const MAX_ERROR_CHARS = 300;

export type ToolRegistry = {
  readonly tools: readonly AnyTool[];
  get(name: string): AnyTool | undefined;
};

export function createToolRegistry(tools: readonly AnyTool[]): ToolRegistry {
  const byName = new Map<string, AnyTool>();
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
    byName.set(tool.name, tool);
  }
  return { tools: [...byName.values()], get: (name) => byName.get(name) };
}

const safeError = (message: string) => truncate(singleLine(redactUntrusted(message)), MAX_ERROR_CHARS);

export type ParsedArgs = { readonly ok: true; readonly args: unknown } | { readonly ok: false; readonly error: string };

export function parseArgs(tool: AnyTool, rawArgs: unknown): ParsedArgs {
  const parsed = tool.argsSchema.safeParse(rawArgs);
  if (parsed.success) return { ok: true, args: parsed.data };
  const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ");
  return { ok: false, error: safeError(`Invalid arguments for ${tool.name}: ${issues}`) };
}

// Everything a tool returns is untrusted and goes back into a prompt. It is capped before redaction so a hostile result cannot make redaction slow, then redacted, then cut to the final size.
export async function executeTool(tool: AnyTool, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = parseArgs(tool, rawArgs);
  if (!parsed.ok) return parsed;
  if (tool.kind === "write" && ctx.dryRun) {
    return { ok: true, text: `dry-run: would run ${tool.name} ${truncate(singleLine(redactUntrusted(JSON.stringify(parsed.args) ?? "")), MAX_ERROR_CHARS)}` };
  }
  try {
    const result = await tool.run(parsed.args, ctx);
    if (!result.ok) return { ok: false, error: safeError(result.error) };
    return { ok: true, text: truncate(redactUntrusted(result.text), MAX_TOOL_RESULT_CHARS) };
  } catch (err) {
    return { ok: false, error: safeError(`${tool.name} failed: ${err instanceof Error ? err.message : String(err)}`) };
  }
}

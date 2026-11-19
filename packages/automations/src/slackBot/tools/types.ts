import type { z } from "zod";

export type ToolKind = "read" | "write";

// Who asked and where, so a write tool can attribute and report its action in the same thread.
export type ToolContext = {
  readonly requestedBy: string;
  readonly channel: string;
  readonly threadTs: string;
  readonly dryRun: boolean;
};

export type ToolResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string };

export type Tool<A> = {
  readonly name: string;
  readonly description: string;
  readonly kind: ToolKind;
  readonly argsSchema: z.ZodType<A>;
  run(args: A, ctx: ToolContext): Promise<ToolResult>;
};

export type AnyTool = Tool<unknown>;

// The registry holds tools of different argument types. The cast is safe because executeTool parses the arguments with argsSchema first.
export const defineTool = <A>(tool: Tool<A>): AnyTool => tool as AnyTool;

export const ok = (data: unknown): ToolResult => ({ ok: true, text: typeof data === "string" ? data : JSON.stringify(data) });
export const failed = (error: string): ToolResult => ({ ok: false, error });

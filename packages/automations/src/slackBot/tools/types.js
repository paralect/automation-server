// The registry holds tools of different argument types. The cast is safe because executeTool parses the arguments with argsSchema first.
export const defineTool = (tool) => tool;
export const ok = (data) => ({ ok: true, text: typeof data === "string" ? data : JSON.stringify(data) });
export const failed = (error) => ({ ok: false, error });

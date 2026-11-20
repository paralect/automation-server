export const errorMessage = (err) => (err instanceof Error ? err.message : String(err));

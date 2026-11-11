export interface ClaimStore {
  claim(key: string): boolean;
  complete(key: string): void;
  release(key: string): void;
  close(): void;
}

export function claimKey(automation: string, externalId: string, project?: string): string {
  return `${project ? `${project}/` : ""}${automation}:${externalId}`;
}

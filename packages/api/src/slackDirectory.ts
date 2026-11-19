export type DirectoryKind = "users" | "channels";

export type DirectoryItem = {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  // Channels only: whether the bot has been invited.
  readonly member?: boolean;
};

export type DirectoryResult = { readonly items: DirectoryItem[]; readonly truncated: boolean };

export type DirectoryRequest = {
  readonly project: string;
  readonly kind: DirectoryKind;
  readonly search?: string;
  readonly refresh?: boolean;
};

export type SlackDirectory = {
  list(request: DirectoryRequest): Promise<DirectoryResult>;
};

export type DirectoryFailure = "no-token" | "missing-scope" | "rejected" | "failed";

export class SlackDirectoryError extends Error {
  constructor(
    readonly kind: DirectoryFailure,
    message: string,
  ) {
    super(message);
    this.name = "SlackDirectoryError";
  }
}

export const MAX_DIRECTORY_ITEMS = 200;

// Matches the label and the @handle, ignoring case and a leading # or @ the person may type.
export function filterDirectory(items: readonly DirectoryItem[], search: string | undefined): DirectoryItem[] {
  const needle = (search ?? "").trim().replace(/^[#@]/, "").toLowerCase();
  const found = needle ? items.filter((i) => `${i.label} ${i.detail ?? ""}`.toLowerCase().includes(needle)) : items;
  return found.slice(0, MAX_DIRECTORY_ITEMS);
}

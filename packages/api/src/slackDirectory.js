export class SlackDirectoryError extends Error {
    kind;
    constructor(kind, message) {
        super(message);
        this.kind = kind;
        this.name = "SlackDirectoryError";
    }
}
export const MAX_DIRECTORY_ITEMS = 200;
// Matches the label and the @handle, ignoring case and a leading # or @ the person may type.
export function filterDirectory(items, search) {
    const needle = (search ?? "").trim().replace(/^[#@]/, "").toLowerCase();
    const found = needle ? items.filter((i) => `${i.label} ${i.detail ?? ""}`.toLowerCase().includes(needle)) : items;
    return found.slice(0, MAX_DIRECTORY_ITEMS);
}

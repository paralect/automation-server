const BY_MESSAGE = {
    UNAUTHORIZED: "unauthorized",
    UNREACHABLE: "unreachable",
    NOT_FOUND: "not-found",
    UNAUTHENTICATED: "session",
};
export function errorKind(error) {
    const message = error instanceof Error ? error.message : "";
    return BY_MESSAGE[message] ?? "server";
}
export const ERROR_COPY = {
    unreachable: {
        title: "Automation server unreachable",
        body: "The admin could not connect to the automation server. Check that it is running and that AUTOMATION_SERVER_URL is correct.",
    },
    unauthorized: {
        title: "Unauthorized",
        body: "The automation server rejected the admin token. ADMIN_API_TOKEN must match the server's ADMIN_API_TOKEN.",
    },
    "not-found": {
        title: "Not found",
        body: "The automation server has no record with that id. It may have been pruned by retention.",
    },
    session: {
        title: "Session expired",
        body: "Your session is no longer valid. Log in again to continue.",
    },
    server: {
        title: "Something went wrong",
        body: "The automation server returned an unexpected error. Try again.",
    },
};
export function errorText(error) {
    const message = error instanceof Error ? error.message : "";
    if (!message || message in BY_MESSAGE || message === "SERVER_ERROR")
        return ERROR_COPY[errorKind(error)].body;
    return message;
}

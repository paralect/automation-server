export const CRISP_SOURCE = "crisp";
export const CRISP_SEGMENTS = "segments";
export const CRISP_RESOLVED = "resolved";
export const AUTOMATION_NOTE_PREFIX = "[automation-server triage]";
export function isCrispSession(event) {
    return event.source === CRISP_SOURCE && (event.kind === CRISP_SEGMENTS || event.kind === CRISP_RESOLVED);
}

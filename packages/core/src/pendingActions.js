export const TRANSITIONS = {
    pending: ["approved", "cancelled", "expired"],
    approved: ["executed", "failed"],
    cancelled: [],
    expired: [],
    executed: [],
    failed: [],
};
export const canTransition = (from, to) => TRANSITIONS[from].includes(to);
export const isTerminal = (status) => TRANSITIONS[status].length === 0;

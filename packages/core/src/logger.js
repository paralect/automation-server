export function createLogger(base = {}, write = (l) => console.log(l), record) {
    const emit = (level) => (message, fields) => {
        const entry = { time: new Date().toISOString(), level, message, fields: { ...base, ...fields } };
        write(JSON.stringify({ time: entry.time, level, message, ...entry.fields }));
        record?.(entry);
    };
    return { info: emit("info"), warn: emit("warn"), error: emit("error") };
}

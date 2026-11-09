import type { LogEntry, LogLevel } from "./activity";

export type LogFields = Readonly<Record<string, unknown>>;

export type Logger = {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
};

export function createLogger(
  base: LogFields = {},
  write: (line: string) => void = (l) => console.log(l),
  record?: (entry: LogEntry) => void,
): Logger {
  const emit = (level: LogLevel) => (message: string, fields?: LogFields) => {
    const entry: LogEntry = { time: new Date().toISOString(), level, message, fields: { ...base, ...fields } };
    write(JSON.stringify({ time: entry.time, level, message, ...entry.fields }));
    record?.(entry);
  };
  return { info: emit("info"), warn: emit("warn"), error: emit("error") };
}

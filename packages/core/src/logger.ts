export type LogFields = Readonly<Record<string, unknown>>;

export type Logger = {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
};

export function createLogger(base: LogFields = {}, write: (line: string) => void = (l) => console.log(l)): Logger {
  const emit = (level: string) => (message: string, fields?: LogFields) =>
    write(JSON.stringify({ time: new Date().toISOString(), level, message, ...base, ...fields }));
  return { info: emit("info"), warn: emit("warn"), error: emit("error") };
}

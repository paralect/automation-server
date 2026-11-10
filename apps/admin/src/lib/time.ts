const absolute = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
})

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
  ["second", 1],
]

export const formatAbsolute = (iso: string) => absolute.format(new Date(iso))

export function formatRelative(iso: string, now = Date.now()) {
  const seconds = Math.round((Date.parse(iso) - now) / 1000)
  const [unit, size] = UNITS.find(([, s]) => Math.abs(seconds) >= s) ?? UNITS[3]!
  return relative.format(Math.round(seconds / size), unit)
}

export function formatDuration(startIso: string, endIso: string | null) {
  if (!endIso) return "running"
  return formatElapsed(Date.parse(endIso) - Date.parse(startIso))
}

export function formatElapsed(ms: number) {
  if (ms < 0) return "0 s"
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`
}

export function formatUptime(totalSeconds: number) {
  const d = Math.floor(totalSeconds / 86_400)
  const h = Math.floor((totalSeconds % 86_400) / 3_600)
  const m = Math.floor((totalSeconds % 3_600) / 60)
  return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`].filter(Boolean).join(" ")
}

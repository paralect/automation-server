const MS_PER_DAY = 86_400_000;

/** ISO 8601 week of a UTC instant, as `YYYY-Www`. The week-year differs from the calendar year around January 1st. */
export function isoWeekKey(now: Date): string {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const weekdayFromMonday = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - weekdayFromMonday + 3);
  const year = day.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((day.getTime() - firstThursday.getTime()) / (7 * MS_PER_DAY));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/**
 * Returns the ISO-week key once the configured weekday (0 is Sunday) and UTC hour have passed in the
 * current ISO week (Monday to Sunday), otherwise null. Every tick after that point returns the same key,
 * so the scheduler's claim on it makes the send happen once per week.
 */
export function isDue(now: Date, dayOfWeek: number, hourUtc: number): string | null {
  const configured = (dayOfWeek + 6) % 7;
  const today = (now.getUTCDay() + 6) % 7;
  const passed = today > configured || (today === configured && now.getUTCHours() >= hourUtc);
  return passed ? isoWeekKey(now) : null;
}

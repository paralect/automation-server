const MS_PER_DAY = 86_400_000;
export function isoWeekKey(now) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const weekdayFromMonday = (day.getUTCDay() + 6) % 7;
    day.setUTCDate(day.getUTCDate() - weekdayFromMonday + 3);
    const year = day.getUTCFullYear();
    const firstThursday = new Date(Date.UTC(year, 0, 4));
    firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
    const week = 1 + Math.round((day.getTime() - firstThursday.getTime()) / (7 * MS_PER_DAY));
    return `${year}-W${String(week).padStart(2, "0")}`;
}
export function isDue(now, dayOfWeek, hourUtc) {
    const configured = (dayOfWeek + 6) % 7;
    const today = (now.getUTCDay() + 6) % 7;
    const passed = today > configured || (today === configured && now.getUTCHours() >= hourUtc);
    return passed ? isoWeekKey(now) : null;
}

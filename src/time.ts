/**
 * Asia/Seoul clock helpers shared by the shuttle and the dorm seminar-room
 * tools. Dates are `YYYY-MM-DD` strings and times `HH:MM`, both Seoul time,
 * so comparisons are plain string comparisons.
 */

export interface SeoulTime {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  weekday: number; // 0 = Sunday
}

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function seoulTime(at: Date): SeoulTime {
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, time: `${p.hour}:${p.minute}`, weekday: new Date(`${date}T00:00:00Z`).getUTCDay() };
}

/** `YYYY-MM-DDTHH:mm` (Seoul time) → Date; undefined → now. */
export function parseAt(at?: string): Date {
  if (!at) return new Date();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at)) {
    throw new Error(`"at" must look like 2026-12-01T08:30 (Seoul time); got "${at}".`);
  }
  const d = new Date(`${at}:00+09:00`);
  if (Number.isNaN(d.getTime())) throw new Error(`"at" is not a real date and time: "${at}".`);
  return d;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** True for a real calendar date in `YYYY-MM-DD` form (rejects 2026-02-30). */
export function isRealDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const weekdayOf = (date: string) => WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
export const isWeekend = (date: string) => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
export const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

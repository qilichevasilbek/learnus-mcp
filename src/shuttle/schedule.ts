/**
 * Which timetable applies on a date, and what leaves next.
 *
 * Everything is Asia/Seoul. The notice to use is the one whose stated service
 * period covers the date — not simply the newest, because the vacation
 * timetable is posted days before the semester one stops applying.
 */
import { listTimetableNotices, loadTimetable } from "./board.js";
import type { Departure, ShuttleTimetable } from "./parse.js";

export type Origin = "sinchon" | "songdo";

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

export const isWeekend = (date: string) => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
export const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

export type Pick =
  | { kind: "found"; timetable: ShuttleTimetable; staleSince?: string }
  | { kind: "none"; latest: ShuttleTimetable | null };

/** Newest-first scan; stops as soon as a notice's period ends before the date. */
export async function timetableFor(date: string, refresh = false): Promise<Pick> {
  const list = await listTimetableNotices(refresh);
  const refs = [...list.value].sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 6);
  let latest: ShuttleTimetable | null = null;
  let stale = list.staleSince;
  const unreadable: string[] = [];
  for (const ref of refs) {
    let got;
    try {
      got = await loadTimetable(ref, refresh);
    } catch (err) {
      // One notice that will not load must not read as "no timetable exists".
      unreadable.push(`${ref.title} (${err instanceof Error ? err.message : err})`);
      continue;
    }
    const t = got.value;
    stale = stale ?? got.staleSince;
    latest ??= t;
    if (t.periodStart <= date && date <= t.periodEnd) return { kind: "found", timetable: t, staleSince: stale };
    if (t.periodEnd < date) break; // every older notice ends earlier still
  }
  if (unreadable.length) {
    throw new Error(`Could not read ${unreadable.length} timetable notice(s), so no timetable could be chosen for ${date}: ${unreadable.join("; ")}`);
  }
  return { kind: "none", latest };
}

export interface Upcoming {
  date: string;
  departure: Departure;
  timetable: ShuttleTimetable;
}

export interface NextResult {
  departures: Upcoming[];
  /** Weekend days passed over on the way. */
  skipped: string[];
  /** Why the search stopped short of `count`, when it did. */
  stopped?: string;
  staleSince?: string;
}

export async function nextDepartures(origin: Origin, now: Date, count: number, refresh = false): Promise<NextResult> {
  const today = seoulTime(now);
  const out: NextResult = { departures: [], skipped: [] };
  for (let offset = 0; offset <= 8 && out.departures.length < count; offset++) {
    const date = addDays(today.date, offset);
    if (isWeekend(date)) {
      out.skipped.push(date);
      continue;
    }
    const pick = await timetableFor(date, refresh);
    if (pick.kind === "none") {
      out.stopped = `no published timetable covers ${date}`;
      break;
    }
    out.staleSince ??= pick.staleSince;
    const all = origin === "sinchon" ? pick.timetable.fromSinchon : pick.timetable.fromSongdo;
    for (const dep of all) {
      if (offset === 0 && dep.time < today.time) continue;
      if (out.departures.length >= count) break;
      out.departures.push({ date, departure: dep, timetable: pick.timetable });
    }
  }
  return out;
}

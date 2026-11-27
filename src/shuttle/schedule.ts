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

export { addDays, isWeekend, minutes, parseAt, seoulTime, type SeoulTime } from "../time.js";
import { addDays, isWeekend, seoulTime } from "../time.js";

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

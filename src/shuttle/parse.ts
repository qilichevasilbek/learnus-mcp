/**
 * Parse one "국제캠퍼스 셔틀버스 운행 시간표" notice from yonsei.ac.kr.
 *
 * The notice body is a single HTML table whose rows are the nth trip of the day,
 * Sinchon departure first and Songdo departure second. Yonsei posts two layouts:
 * the semester one (numbered trips, a vehicle after each time, a 경유 cell that
 * spans rows, so 5 or 7 cells per row) and the vacation one (four columns, three
 * trips, no vehicles, one time marked `*`). Nothing here reads by column index:
 * a row is its `H:MM` cells, each optionally followed by a vehicle cell. A row
 * that does not yield exactly two times is an error, never a silent gap — a
 * wrong timetable is worth less than none.
 */
import * as cheerio from "cheerio";

export interface Departure {
  /** 24-hour `HH:MM`, Asia/Seoul. */
  time: string;
  /** As published, e.g. `버스1호` or `장애인2호`. Vacation timetables name no vehicles. */
  vehicle: string | null;
  /** `장애인` vehicles are the wheelchair-accessible ones. */
  accessible: boolean;
  /** The notice marks this time with `*` (it gives no reason). */
  marked: boolean;
}

export interface ShuttleTimetable {
  noticeId: string;
  title: string;
  url: string;
  /** Date the notice was posted, `YYYY-MM-DD`, from the board listing. */
  postedDate: string | null;
  /** Service period, inclusive, `YYYY-MM-DD`. */
  periodStart: string;
  periodEnd: string;
  fromSinchon: Departure[];
  fromSongdo: Departure[];
  routeFromSinchon: string | null;
  routeFromSongdo: string | null;
  /** The notice's own note on the highway route, when it gives one. */
  via: string | null;
  /** The notice states there is no service on Saturdays, Sundays and holidays. */
  noWeekendOrHolidayService: boolean;
  tripMinutes: number | null;
}

export class ShuttleParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShuttleParseError";
  }
}

const TIME = /^\*?\s*\d{1,2}:\d{2}$/;
const clean = (s: string) => s.replace(/ /g, " ").replace(/\s+/g, " ").trim();
const hhmm = (cell: string) => {
  const t = cell.replace(/^\*\s*/, "");
  return t.length === 4 ? `0${t}` : t;
};
const tidyRoute = (r: string) => r.replace(/->/g, "→").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
const iso = (y: string, m: string, d: string) => `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;

export function parseNotice(
  html: string,
  meta: { id: string; title: string; url: string; postedDate: string | null }
): ShuttleTimetable {
  const $ = cheerio.load(html);
  const body = $(".viewCont").first();
  if (!body.length) {
    throw new ShuttleParseError(`${meta.url}: the notice body was not found — Yonsei's page layout may have changed.`);
  }
  const text = clean(body.text());

  const period = text.match(
    /운행\s*기간[\s:：]*(\d{4})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})[^~]{0,20}~\s*(\d{4})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})/
  );
  if (!period) {
    throw new ShuttleParseError(`${meta.url}: no service period ("운행기간") found, so this timetable cannot be dated.`);
  }

  const fromSinchon: Departure[] = [];
  const fromSongdo: Departure[] = [];
  const routes: string[] = [];
  let via: string | null = null;

  body.find("table tr").each((_, tr) => {
    const cells = $(tr)
      .children("td,th")
      .toArray()
      .map((c) => clean($(c).text()));

    if (cells.length === 2 && cells.every((c) => /→|->/.test(c))) routes.push(...cells.map(tidyRoute));

    const at = cells.flatMap((c, i) => (TIME.test(c) ? [i] : []));
    if (!at.length) return; // header, route and spacer rows
    if (at.length !== 2) {
      throw new ShuttleParseError(
        `${meta.url}: a trip row has ${at.length} departure time(s) instead of 2 (${JSON.stringify(cells)}).`
      );
    }
    const [a, b] = at.map((i) => {
      const next = (cells[i + 1] ?? "").replace(/\s+/g, "");
      const vehicle = next.endsWith("호") ? next : null;
      return {
        time: hhmm(cells[i]),
        vehicle,
        accessible: Boolean(vehicle?.includes("장애인")),
        marked: cells[i].startsWith("*"),
      } satisfies Departure;
    });
    fromSinchon.push(a);
    fromSongdo.push(b);
    const note = cells[at[0] + (a.vehicle ? 2 : 1)];
    if (!via && note && !TIME.test(note) && !/^\d+$/.test(note)) via = note.replace(/\s*\/\s*/g, " · ");
  });

  if (!fromSinchon.length || !fromSongdo.length) {
    throw new ShuttleParseError(`${meta.url}: no departures were found in the timetable table.`);
  }
  const byTime = (x: Departure, y: Departure) => x.time.localeCompare(y.time);
  fromSinchon.sort(byTime);
  fromSongdo.sort(byTime);

  // "약 1시간 30분 정도 소요" — anchored on 소요 and not preceded by a Hangul syllable, so
  // "예약 1시간 전에 취소" (cancel 1 hour before booking) is not read as a trip time.
  const trip = text.match(/(?<![가-힣])약\s*(\d+)\s*시간(?:\s*(\d+)\s*분)?[^.※]{0,12}소요/);
  return {
    noticeId: meta.id,
    title: meta.title,
    url: meta.url,
    postedDate: meta.postedDate,
    periodStart: iso(period[1], period[2], period[3]),
    periodEnd: iso(period[4], period[5], period[6]),
    fromSinchon,
    fromSongdo,
    routeFromSinchon: routes[0] ?? null,
    routeFromSongdo: routes[1] ?? null,
    via,
    noWeekendOrHolidayService: /(?:토요일|일요일).{0,10}공휴일\S{0,2}\s*운행\s*없음/.test(text),
    tripMinutes: trip ? Number(trip[1]) * 60 + Number(trip[2] ?? 0) : null,
  };
}

/**
 * LMS calendar events, read from the month grid rather than the action feed.
 *
 * The first version of this scraper called
 * `core_calendar_get_action_events_by_timesort`, which is what Moodle's
 * dashboard uses. That endpoint answers a narrower question than it looks like
 * it does: it returns only *action* events — an activity with an outstanding
 * student action — inside a 30-day window. On a live semester that came back
 * with two rows, and silently omitted a 30%-weighted essay, every Zoom class
 * session, every quiz open/close window and two entire courses.
 *
 * `core_calendar_get_calendar_monthly_view` is the API behind
 * https://ys.learnus.org/calendar/view.php?view=month and returns everything
 * the calendar knows: due, open, close, start, stop, expectcompletionon, zoom
 * sessions, VOD windows, Turnitin parts and user-created events. On the same
 * day it returned 36 events where the action feed returned 2.
 */
import { logger } from "../logger.js";
import type { MoodleAPI } from "../moodle-api.js";
import type { CourseMap } from "./courses.js";

export interface CalendarEvent {
  /** Moodle event id. Not unique on its own — repeating events reuse it. */
  id: number;
  name: string;
  description: string;
  /** ISO 8601, or null if Moodle gave no start time. */
  timestart: string | null;
  /** ISO 8601 end, present only for events with a duration (e.g. Zoom classes). */
  timeend: string | null;
  timeduration: number;
  /** due · close · open · start · stop · expectcompletionon · zoom · user · … */
  eventtype: string;
  /** Activity module: assign, quiz, zoom, vod, turnitintooltwo, choice, url. */
  modname: string | null;
  url: string;
  /** Course fullname as LearnUS writes it. */
  course: string;
  /** Localised time string straight from Moodle, already stripped of markup. */
  formattedTime: string;
  /** True when this is something the student still has to act on. */
  actionable: boolean;
}

export interface CalendarWindow {
  /** First month included, "YYYY-MM". */
  from: string;
  /** Last month included, "YYYY-MM". */
  to: string;
}

interface RawEvent {
  id?: number;
  name?: string;
  description?: string;
  modulename?: string | null;
  eventtype?: string;
  timestart?: number;
  timeduration?: number;
  formattedtime?: string;
  isactionevent?: boolean;
  url?: string;
  viewurl?: string;
  course?: { id?: number; fullname?: string };
  courseid?: number;
}

const stripHtml = (html: string): string =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

/** Today's year/month in Seoul, which is the timezone LearnUS reports in. */
export function seoulYearMonth(now = new Date()): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get("year"), month: get("month") };
}

/** Shift a {year, month} pair by `delta` months, keeping month in 1-12. */
export function shiftMonth(
  ym: { year: number; month: number },
  delta: number
): { year: number; month: number } {
  const zero = ym.year * 12 + (ym.month - 1) + delta;
  return { year: Math.floor(zero / 12), month: (zero % 12) + 1 };
}

export const monthKey = (ym: { year: number; month: number }): string =>
  `${ym.year}-${String(ym.month).padStart(2, "0")}`;

function normalise(event: RawEvent, courseMap: CourseMap): { code: string; event: CalendarEvent } {
  const courseId = event.course?.id ?? event.courseid;
  const info = courseId ? courseMap[courseId] : undefined;
  const duration = event.timeduration ?? 0;
  const start = event.timestart ?? null;

  return {
    code: info?.localCode || "general",
    event: {
      id: event.id ?? 0,
      name: event.name ?? "",
      description: stripHtml(event.description ?? "").slice(0, 300),
      timestart: start ? new Date(start * 1000).toISOString() : null,
      timeend: start && duration > 0 ? new Date((start + duration) * 1000).toISOString() : null,
      timeduration: duration,
      eventtype: event.eventtype ?? "",
      modname: event.modulename ?? null,
      url: event.url || event.viewurl || "",
      course: info?.fullname || event.course?.fullname || "Unknown",
      formattedTime: stripHtml(event.formattedtime ?? ""),
      actionable: event.isactionevent === true,
    },
  };
}

function collectMonthEvents(view: unknown): RawEvent[] {
  const weeks = (view as { weeks?: Array<{ days?: Array<{ events?: RawEvent[] }> }> })?.weeks ?? [];
  const out: RawEvent[] = [];
  for (const week of weeks) {
    for (const day of week.days ?? []) {
      for (const event of day.events ?? []) out.push(event);
    }
  }
  return out;
}

export interface CalendarScrapeOptions {
  /** Months before the current one to include. Default 1, so "what was due last week" still answers. */
  monthsBack?: number;
  /** Months after the current one to include. Default 2. */
  monthsAhead?: number;
  /** Fetch exactly these months instead of a window around today. */
  months?: Array<{ year: number; month: number }>;
}

/**
 * Fetch the calendar across a window of months and group by course code.
 *
 * One request per month, plus the upcoming panel as a safety net for anything
 * the grid happens to omit. Failures are per-month: a single bad request costs
 * that month, not the whole scrape.
 */
export async function scrapeCalendarEvents(
  api: MoodleAPI,
  courseMap: CourseMap,
  opts: CalendarScrapeOptions = {}
): Promise<Record<string, CalendarEvent[]>> {
  const { monthsBack = 1, monthsAhead = 2 } = opts;
  const anchor = seoulYearMonth();
  const months =
    opts.months ??
    Array.from({ length: monthsBack + monthsAhead + 1 }, (_, i) =>
      shiftMonth(anchor, i - monthsBack)
    );

  logger.info(
    `Scraping calendar months ${monthKey(months[0])}..${monthKey(months[months.length - 1])}`
  );

  const raw: RawEvent[] = [];
  for (const ym of months) {
    try {
      raw.push(...collectMonthEvents(await api.getMonthlyCalendar(ym.year, ym.month)));
    } catch (e) {
      logger.warn(`Calendar month ${monthKey(ym)} failed: ${(e as Error).message}`);
    }
  }

  try {
    const upcoming = (await api.getUpcomingCalendar()) as { events?: RawEvent[] };
    raw.push(...(upcoming?.events ?? []));
  } catch (e) {
    logger.warn(`Upcoming calendar view failed: ${(e as Error).message}`);
  }

  // Repeating activities (a weekly Zoom session) reuse one event id across
  // occurrences, so the id alone is not a key — the start time is part of it.
  const seen = new Set<string>();
  const grouped: Record<string, CalendarEvent[]> = {};

  for (const rawEvent of raw) {
    const { code, event } = normalise(rawEvent, courseMap);
    const key = `${event.id}:${event.eventtype}:${event.timestart ?? "?"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (grouped[code] ??= []).push(event);
  }

  for (const events of Object.values(grouped)) {
    events.sort((a, b) => (a.timestart ?? "").localeCompare(b.timestart ?? ""));
  }

  const total = Object.values(grouped).reduce((n, e) => n + e.length, 0);
  logger.info(
    `Found ${total} calendar events across ${Object.keys(grouped).length} courses ` +
      `(${months.length} months)`
  );
  return grouped;
}

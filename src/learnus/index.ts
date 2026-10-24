/**
 * MCP tool server for Yonsei coursework.
 *
 * Two rules shape this file:
 *
 * 1. **No course code is ever hardcoded.** Enrollment changes every term; the
 *    course list is discovered from LearnUS and the academic portal and read
 *    back from the cache. Tool descriptions describe the *shape* of a course
 *    code, never a specific semester's list.
 * 2. **Read the cache, scrape only on request.** Every tool used to launch a
 *    headless Chromium and re-authenticate inside the chat turn. They now
 *    answer from the local cache (see `LEARNUS_MCP_HOME`) in about a millisecond and take
 *    `refresh: true` when genuinely fresh data is needed.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createMcpServer, tool } from "../mcp.js";
import * as browser from "./browser.js";
import { login } from "./auth.js";
import { MoodleAPI } from "./moodle-api.js";
import {
  discoverCourses,
  loadCourseMap,
  activeCourseCodes,
  type CourseMap,
} from "./scrapers/courses.js";
import { scrapeAnnouncements } from "./scrapers/announcements.js";
import { scrapeAssignments } from "./scrapers/assignments.js";
import { scrapeMaterials } from "./scrapers/materials.js";
import {
  scrapeCalendarEvents,
  seoulYearMonth,
  shiftMonth,
  monthKey,
  type CalendarEvent,
} from "./scrapers/calendar.js";
import { scrapeGrades, type CourseGrades } from "./scrapers/grades.js";
import {
  fetchTimetable,
  fetchAttendance,
  assessRisk,
  type AttendanceSummary,
  type TimetableEntry,
} from "./rollbook.js";
import { readCache, writeCache, describeAge, readSyncState, type CacheKey } from "./cache.js";
import { runSync } from "./sync.js";
import { fetchSingleAnnouncement, fetchUrl } from "./fetch-single.js";
import * as config from "./config.js";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

async function getAuthenticatedContext() {
  const { context } = await browser.launch();
  const sesskey = await login(context);
  if (!sesskey) throw new Error("Failed to authenticate with LearnUS");
  return { context, sesskey };
}

async function getCourseMap(
  context: import("playwright").BrowserContext
): Promise<CourseMap> {
  const cached = loadCourseMap();
  if (cached && Object.keys(cached).length > 0) {
    try {
      const age = Date.now() - fs.statSync(config.COURSE_MAP_FILE).mtimeMs;
      if (age < 7 * 24 * 60 * 60 * 1000) return cached;
    } catch {
      /* fall through to discovery */
    }
  }
  return discoverCourses(context);
}

/**
 * Serve `key` from cache unless `refresh` is set or nothing has ever been
 * cached, in which case fall back to the live scrape and cache the result.
 */
async function cacheFirst<T>(
  key: CacheKey,
  refresh: boolean,
  live: () => Promise<T>
): Promise<{ data: T; provenance: string }> {
  if (!refresh) {
    const hit = readCache<T>(key);
    if (hit) {
      return {
        data: hit.data,
        provenance:
          `Source: cache, updated ${describeAge(hit.ageMs)}` +
          (hit.stale ? " (stale — pass refresh:true for live data)" : ""),
      };
    }
  }
  const data = await live();
  writeCache(key, data);
  return { data, provenance: "Source: live scrape (cache updated)" };
}

function filterByCode<T>(
  data: Record<string, T[]>,
  course?: string
): Record<string, T[]> {
  if (!course) return data;
  const upper = course.toUpperCase();
  const filtered: Record<string, T[]> = {};
  for (const [code, items] of Object.entries(data)) {
    if (code.toUpperCase() === upper) filtered[code] = items;
  }
  return filtered;
}

const COURSE_ARG = z
  .string()
  .optional()
  .describe(
    "Course code such as UIC2101 or QRM2001. Omit for all courses. Call learnus_courses if you need the current list."
  );

const REFRESH_ARG = z
  .boolean()
  .optional()
  .describe(
    "Force a live scrape instead of reading the cache. Slow (30-60s) — only set this when the cached data is known to be stale or the user explicitly asks for fresh data."
  );

/* -------------------------------------------------------------- rendering --- */

const DAY_ORDER = ["월", "화", "수", "목", "금", "토", "일"];
const DAY_EN: Record<string, string> = {
  월: "monday",
  화: "tuesday",
  수: "wednesday",
  목: "thursday",
  금: "friday",
  토: "saturday",
  일: "sunday",
};

function renderTimetable(entries: TimetableEntry[]): string {
  if (!entries.length) return "No timetable entries found.";

  const lines = [
    "| Course | Title | Professor | When | Where | Format |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const e of entries) {
    const where = e.format === "online" ? "Online" : `${e.building} ${e.room}`.trim();
    lines.push(
      `| ${e.courseNo} | ${e.title} | ${e.professor} | ${e.periodNotation || "—"} | ${where || "—"} | ${e.format} |`
    );
  }

  // A day-by-day view is what actually answers "what do I have on Wednesday".
  const byDay = new Map<string, string[]>();
  for (const e of entries) {
    for (const m of e.meetings) {
      const where = e.format === "online" ? "online" : `${e.building} ${e.room}`.trim();
      const list = byDay.get(m.day) ?? [];
      list.push(
        `${m.start}-${m.end}  ${e.code} ${e.title} (period ${m.periods.join(",")}) — ${where || "?"}`
      );
      byDay.set(m.day, list);
    }
  }
  lines.push("", "### Weekly grid");
  for (const day of DAY_ORDER) {
    const items = byDay.get(day);
    if (!items?.length) continue;
    lines.push(`**${day}**`);
    for (const item of items.sort()) lines.push(`- ${item}`);
  }
  return lines.join("\n");
}

function renderAttendance(summary: AttendanceSummary): string {
  const lines: string[] = [
    `Semester ${summary.semester} · fetched ${summary.fetchedAt}`,
    `Totals — present ${summary.totals.present}, late ${summary.totals.late}, absent ${summary.totals.absent}, early leave ${summary.totals.earlyLeave}`,
  ];
  if (summary.chapelSeat) lines.push(`Chapel assigned seat: ${summary.chapelSeat}`);
  lines.push(
    "",
    "| Course | Present | Late | Absent | Held | Planned | Risk |",
    "| --- | --- | --- | --- | --- | --- | --- |"
  );

  const warnings: string[] = [];
  for (const r of summary.courses) {
    const risk = assessRisk(r);
    lines.push(
      `| ${r.courseNo} ${r.title} | ${r.present} | ${r.late} | ${r.absent} | ${r.heldSessions} | ${r.plannedSessions} | ${risk.level} |`
    );
    if (risk.level !== "ok") warnings.push(`- **${r.code}** — ${risk.message}`);

    const missed = r.sessions.filter(
      (s) => s.status === "absent" || s.status === "late" || s.status === "early-leave"
    );
    if (missed.length) {
      warnings.push(
        `- ${r.code} flagged sessions: ${missed.map((s) => `${s.date} (${s.status})`).join(", ")}`
      );
    }
  }

  if (warnings.length) lines.push("", "### Attention", ...warnings);
  return lines.join("\n");
}

const KST = "Asia/Seoul";

/** "Mon 22 Sep" — the day heading events are grouped under. */
function kstDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    timeZone: KST,
    weekday: "short",
    day: "2-digit",
    month: "short",
  });
}

function kstTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: KST,
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** YYYY-MM of an instant, in Seoul. */
function kstMonth(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", {
    timeZone: KST,
    year: "numeric",
    month: "2-digit",
  });
}

/** Event types that represent something the student must hand in or attend. */
const DEADLINE_TYPES = new Set(["due", "close", "expectcompletionon", "stop"]);

function renderCalendar(
  rows: Array<CalendarEvent & { code: string }>,
  heading: string
): string {
  if (!rows.length) return `${heading}\n\n_No events in this range._`;

  const lines = [heading, ""];
  let currentDay = "";
  for (const e of rows) {
    const day = e.timestart ? kstDay(e.timestart) : "No date";
    if (day !== currentDay) {
      lines.push(`### ${day}`);
      currentDay = day;
    }
    const when = e.timestart
      ? e.timeend
        ? `${kstTime(e.timestart)}–${kstTime(e.timeend)}`
        : kstTime(e.timestart)
      : "—";
    const flag = DEADLINE_TYPES.has(e.eventtype) ? " **[deadline]**" : "";
    const action = e.actionable ? " _(action required)_" : "";
    const kind = e.modname ? `${e.modname}/${e.eventtype}` : e.eventtype;
    lines.push(`- ${when} · ${e.code} · ${e.name} — ${kind}${flag}${action}`);
    if (e.url) lines.push(`  ${e.url}`);
  }
  return lines.join("\n");
}

function renderGrades(courses: CourseGrades[]): string {
  if (!courses.length) return "No gradebook data. Run learnus_sync to populate it.";

  const lines: string[] = [
    "| Course | Title | Graded items | Course total |",
    "| --- | --- | --- | --- |",
  ];
  for (const c of courses) {
    lines.push(`| ${c.code} | ${c.title} | ${c.gradedCount} | ${c.courseTotal ?? "—"} |`);
  }

  for (const c of courses) {
    if (!c.items.length) continue;
    lines.push("", `### ${c.code} — ${c.title}`);
    let category = "";
    for (const i of c.items) {
      if (i.category && i.category !== category) {
        category = i.category;
        lines.push(`**${category}**`);
      }
      const bits = [
        `grade ${i.grade ?? "—"}`,
        i.weight ? `weight ${i.weight}` : null,
        i.contribution ? `contributes ${i.contribution}` : null,
        i.feedback ? `feedback: ${i.feedback}` : null,
      ].filter(Boolean);
      lines.push(`${i.isTotal ? "" : "- "}${i.name}: ${bits.join(" · ")}`);
    }
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ server --- */

export function createLearnusServer() {
  return createMcpServer({
    name: "learnus-tools",
    version: "2.1.0",
    tools: [
      tool(
        "learnus_sync",
        `Run a full refresh of all Yonsei coursework data and rebuild the local cache.

Scrapes, in one authenticated browser session:
- the official timetable and attendance record from the 전자출결 portal (ysrollbook.yonsei.ac.kr)
- announcements, assignments/quizzes/Turnitin papers, and materials from LearnUS
  (including links posted inside the weekly section descriptions)
- the gradebook: every recorded mark, its weight and instructor feedback
- the LearnUS month calendar, a month back through two months ahead
- syllabus/schedule documents, downloaded and transcribed to text

Takes 60-120 seconds. Every other learnus_* tool reads the cache this writes, so
they answer instantly afterwards. Each source is fetched independently — one failing
service still leaves the rest updated, and the returned status says which failed.

Writes JSON under the server's cache directory plus per-course Markdown in courses/<CODE>/.

Use this when: the user explicitly asks to refresh, or learnus_last_run shows the
cache is old. If a scheduled "learnus-mcp sync" is running it keeps the cache current, so
prefer simply reading the other tools.`,
        {
          rediscover: z
            .boolean()
            .optional()
            .describe("Re-discover the enrolled course list even if the cached map is fresh. Use at the start of a new semester."),
          skipSyllabus: z
            .boolean()
            .optional()
            .describe("Skip downloading and transcribing syllabus documents (the slowest step)."),
        },
        async (args) => {
          const state = await runSync({
            rediscover: args.rediscover,
            skipSyllabus: args.skipSyllabus,
          });
          const stepLines = Object.entries(state.steps)
            .map(
              ([name, s]) =>
                `- ${name}: ${s.ok ? "ok" : "FAILED"}` +
                (s.count !== undefined ? ` (${s.count})` : "") +
                (s.error ? ` — ${s.error}` : "")
            )
            .join("\n");
          return textResult(
            `Sync ${state.status} in ${(state.durationMs / 1000).toFixed(1)}s — ${state.courseCount} courses.\n\n${stepLines}` +
              (state.error ? `\n\nFatal: ${state.error}` : "")
          );
        }
      ),

      tool(
        "portal_timetable",
        `Get the AUTHORITATIVE class timetable from Yonsei's 전자출결 portal (ysrollbook.yonsei.ac.kr).

This is the official registrar record and the only reliable answer to "when and where
is my class". Per registered course it returns:
- exact meeting days and Yonsei period numbers (e.g. 수1, 금1,2 — period N runs (N+8):00-(N+8):50)
- clock times, building and room (e.g. 진리관B / I진B303)
- professor name and delivery format (in-person vs real-time online)

IMPORTANT: prefer this over any inference from LearnUS. A LearnUS course page showing
only homework and quizzes does NOT mean the class is asynchronous — several in-person
courses look exactly like that. Courses registered in the portal but with no LearnUS
page at all appear here and nowhere else.

Reads the cache by default; pass refresh:true to re-query the portal live.`,
        {
          course: COURSE_ARG,
          day: z
            .string()
            .optional()
            .describe("Filter to one weekday. Accepts Korean (월화수목금토일) or English (Monday, Mon, ...)."),
          refresh: REFRESH_ARG,
        },
        async (args) => {
          const { data, provenance } = await cacheFirst<TimetableEntry[]>(
            "timetable",
            args.refresh ?? false,
            async () => {
              const { context } = await getAuthenticatedContext();
              return fetchTimetable(context, config.currentSemester());
            }
          );

          let entries = data;
          if (args.course) {
            const upper = args.course.toUpperCase();
            entries = entries.filter(
              (e) => e.code.toUpperCase() === upper || e.courseNo.toUpperCase() === upper
            );
          }
          if (args.day) {
            const want = args.day.trim().toLowerCase();
            const ko = DAY_ORDER.find(
              (d) => d === args.day!.trim() || DAY_EN[d].startsWith(want)
            );
            if (ko) {
              entries = entries
                .map((e) => ({ ...e, meetings: e.meetings.filter((m) => m.day === ko) }))
                .filter((e) => e.meetings.length > 0);
            }
          }

          return textResult(`${provenance}\n\n${renderTimetable(entries)}`);
        }
      ),

      tool(
        "learnus_attendance",
        `Get the official electronic attendance record (전자출결) from ysrollbook.yonsei.ac.kr.

Yonsei enforces attendance strictly: missing more than one third of a course's sessions
is an automatic F, and three late arrivals normally count as one absence. This tool
returns per course: present / late / absent / early-leave counts, sessions held so far,
sessions planned for the term, the exact date of every missed or late session, and a
computed risk level (ok / watch / warning / critical) against the 1/3 rule. It also
reports the assigned Chapel seat, which Chapel attendance tagging depends on.

Note: LearnUS's own attendance pages are empty at this university — this portal is the
only real source.

Use proactively when the user asks about attendance, absences, whether they can skip a
class, or Chapel. Reads the cache by default; pass refresh:true for live data.`,
        {
          course: COURSE_ARG,
          refresh: REFRESH_ARG,
        },
        async (args) => {
          const { data, provenance } = await cacheFirst<AttendanceSummary>(
            "attendance",
            args.refresh ?? false,
            async () => {
              const { context } = await getAuthenticatedContext();
              return fetchAttendance(context, config.currentSemester());
            }
          );

          let summary = data;
          if (args.course) {
            const upper = args.course.toUpperCase();
            summary = {
              ...data,
              courses: data.courses.filter(
                (c) => c.code.toUpperCase() === upper || c.courseNo.toUpperCase() === upper
              ),
            };
          }
          return textResult(`${provenance}\n\n${renderAttendance(summary)}`);
        }
      ),

      tool(
        "learnus_assignments",
        `Get assignments, quizzes and their due dates from LearnUS.

Covers Moodle assignments, quizzes AND Turnitin papers (mod/turnitintooltwo), which are
often the highest-weighted work in a course. A Turnitin activity is reported one row per
part, named "<Activity> - Part N" so it matches how learnus_calendar names the same
deadline.

Returns per item: name, URL, type (assign/quiz/turnitintooltwo), section, due date,
submission status.

Reads the local cache by default (instant). Pass refresh:true to re-scrape live, which
visits every assignment detail page and takes 30-60s. To read one Turnitin activity in
full — prompt text, all parts, similarity and grade — use learnus_fetch_url on its URL.`,
        { course: COURSE_ARG, refresh: REFRESH_ARG },
        async (args) => {
          const { data, provenance } = await cacheFirst<Record<string, unknown[]>>(
            "assignments",
            args.refresh ?? false,
            async () => {
              const { context } = await getAuthenticatedContext();
              const courseMap = await getCourseMap(context);
              const result = await scrapeAssignments(context, courseMap);
              return result as unknown as Record<string, unknown[]>;
            }
          );
          return textResult(
            `${provenance}\n\n${JSON.stringify(filterByCode(data, args.course), null, 2)}`
          );
        }
      ),

      tool(
        "learnus_announcements",
        `Get course announcements and notices from LearnUS boards.

Returns per announcement: title, URL, date, author. To read the body of one, pass its
URL to learnus_fetch_announcement.

Reads the local cache by default (instant). Pass refresh:true to re-scrape live.`,
        { course: COURSE_ARG, refresh: REFRESH_ARG },
        async (args) => {
          const { data, provenance } = await cacheFirst<Record<string, unknown[]>>(
            "announcements",
            args.refresh ?? false,
            async () => {
              const { context } = await getAuthenticatedContext();
              const courseMap = await getCourseMap(context);
              const result = await scrapeAnnouncements(context, courseMap);
              return result as unknown as Record<string, unknown[]>;
            }
          );
          return textResult(
            `${provenance}\n\n${JSON.stringify(filterByCode(data, args.course), null, 2)}`
          );
        }
      ),

      tool(
        "learnus_materials",
        `Get course materials from LearnUS: lecture slides, PDFs, folders, video lectures (vod), external URLs and Moodle pages.

Also includes links the instructor wrote into the weekly section descriptions rather
than uploading as files — returned with source:"section-summary" and external:true when
they point off-site. Readings are frequently posted ONLY this way, as Google Drive or
Docs links, in a course whose module list looks nearly empty. Treat a small module count
as no evidence that a course has no readings.

Returns per item: name, type, section, URL, source, external.

Reads the local cache by default (instant). Pass refresh:true to re-scrape live.`,
        { course: COURSE_ARG, refresh: REFRESH_ARG },
        async (args) => {
          const { data, provenance } = await cacheFirst<Record<string, unknown[]>>(
            "materials",
            args.refresh ?? false,
            async () => {
              const { context } = await getAuthenticatedContext();
              const courseMap = await getCourseMap(context);
              const result = await scrapeMaterials(context, courseMap);
              return result as unknown as Record<string, unknown[]>;
            }
          );
          return textResult(
            `${provenance}\n\n${JSON.stringify(filterByCode(data, args.course), null, 2)}`
          );
        }
      ),

      tool(
        "learnus_calendar",
        `Get LMS calendar events from the LearnUS month calendar (https://ys.learnus.org/calendar/view.php?view=month).

This is the single most complete view of what is happening in a course. It returns
every event type the calendar carries, not just open assignments:
- **due** / **close** — hand-in deadlines and the moment a quiz window shuts
- **open** / **start** — when a quiz, choice or video becomes available
- **expectcompletionon** — the instructor's "you should be done by" target
- **zoom** — scheduled real-time class sessions, with their start and end times
- Turnitin parts, VOD availability windows, and student-created personal events

Courses with no assignment activity still appear here, and so do events for which
nothing is outstanding — both are invisible to learnus_assignments.

Defaults to the next 30 days. Pass month:"2026-10" for a whole calendar month (any
month, past or future — outside the cached window it queries live), days:N to widen
or narrow the forward window, includePast:true to look back, or deadlinesOnly:true to
drop class sessions and opening times and keep only the things that can be missed.

For the personal iCloud calendar use calendar_today / calendar_events instead.`,
        {
          course: COURSE_ARG,
          month: z
            .string()
            .optional()
            .describe('A whole calendar month as "YYYY-MM", e.g. "2026-10". Overrides days/includePast.'),
          days: z
            .number()
            .optional()
            .describe("Size of the forward window in days. Default 30. Ignored when month is set."),
          includePast: z
            .boolean()
            .optional()
            .describe("Also include events from the last 30 days. Default false."),
          deadlinesOnly: z
            .boolean()
            .optional()
            .describe("Keep only due/close/completion/stop events — the things with consequences."),
          refresh: REFRESH_ARG,
        },
        async (args) => {
          const now = Date.now();
          const days = args.days ?? 30;
          const anchor = seoulYearMonth();

          // Validated before anything launches a browser: an unparseable month
          // used to cost a full SSO round trip before it could be rejected.
          let explicitMonth: { year: number; month: number } | null = null;
          if (args.month) {
            const [year, month] = args.month.split("-").map(Number);
            if (!year || !month || month < 1 || month > 12) {
              return textResult(`Invalid month "${args.month}" — expected YYYY-MM.`);
            }
            explicitMonth = { year, month };
          }

          // Which calendar months the answer needs, so we can tell whether the
          // cache can serve it without going near the network.
          const wantedMonths = args.month
            ? [args.month]
            : (() => {
                const endMonth = kstMonth(new Date(now + days * 86_400_000).toISOString());
                const months: string[] = [];
                let cursor = args.includePast ? shiftMonth(anchor, -1) : anchor;
                for (let i = 0; i < 24; i += 1) {
                  const key = monthKey(cursor);
                  months.push(key);
                  if (key >= endMonth) break;
                  cursor = shiftMonth(cursor, 1);
                }
                return months;
              })();

          const hit = args.refresh
            ? null
            : readCache<Record<string, CalendarEvent[]>>("calendar");

          // The sync caches a month back through two months ahead of its own
          // run date; anything outside that has to be fetched.
          const defaultWindow = Array.from({ length: 4 }, (_, i) =>
            monthKey(shiftMonth(anchor, i - 1))
          );
          const covered = hit
            ? new Set(
                Array.from({ length: 4 }, (_, i) =>
                  monthKey(shiftMonth(seoulYearMonth(hit.fetchedAt), i - 1))
                )
              )
            : new Set<string>();
          const uncovered = wantedMonths.filter((m) => !covered.has(m));

          let data: Record<string, CalendarEvent[]>;
          let provenance: string;

          if (hit && uncovered.length === 0) {
            data = hit.data;
            provenance =
              `Source: cache, updated ${describeAge(hit.ageMs)}` +
              (hit.stale ? " (stale — pass refresh:true for live data)" : "");
          } else {
            const { context, sesskey } = await getAuthenticatedContext();
            const courseMap = await getCourseMap(context);
            const api = new MoodleAPI(context, sesskey);
            try {
              if (explicitMonth) {
                // A one-off month query must not shrink the cached window.
                data = await scrapeCalendarEvents(api, courseMap, {
                  months: [explicitMonth],
                });
                provenance = `Source: live query for ${args.month}`;
              } else {
                // The standard sync window, widened to whatever was actually
                // asked for. Fetching only -1..+2 here meant days:120 answered
                // from a three-month grid and silently dropped the rest.
                const months = Array.from(new Set([...defaultWindow, ...wantedMonths]))
                  .sort()
                  .map((key) => {
                    const [year, month] = key.split("-").map(Number);
                    return { year, month };
                  });
                data = await scrapeCalendarEvents(api, courseMap, { months });
                writeCache("calendar", data);
                provenance = `Source: live query (${months.length} month${
                  months.length === 1 ? "" : "s"
                }, cache updated)`;
              }
            } finally {
              await api.close().catch(() => {});
            }
          }

          let rows = Object.entries(filterByCode(data, args.course)).flatMap(
            ([code, events]) => events.map((e) => ({ ...e, code }))
          );

          if (args.month) {
            rows = rows.filter((e) => e.timestart && kstMonth(e.timestart) === args.month);
          } else {
            const from = args.includePast ? now - 30 * 86_400_000 : now;
            const to = now + days * 86_400_000;
            rows = rows.filter((e) => {
              if (!e.timestart) return false;
              const t = new Date(e.timestart).getTime();
              return t >= from && t <= to;
            });
          }

          if (args.deadlinesOnly) {
            rows = rows.filter((e) => DEADLINE_TYPES.has(e.eventtype));
          }
          rows.sort((a, b) => (a.timestart ?? "").localeCompare(b.timestart ?? ""));

          const range = args.month
            ? `month ${args.month}`
            : `${args.includePast ? "last 30 days and " : ""}next ${days} days`;
          const heading = `## LearnUS calendar — ${range}${
            args.deadlinesOnly ? " (deadlines only)" : ""
          } · ${rows.length} event${rows.length === 1 ? "" : "s"}`;

          return textResult(`${provenance}\n\n${renderCalendar(rows, heading)}`);
        }
      ),

      tool(
        "learnus_grades",
        `Get the marks actually recorded in the LearnUS gradebook.

Returns, per course, every grade item with: the score received, the weight it carries
toward the final mark, the gradebook category it sits under, its contribution to the
course total so far, and any instructor feedback attached to it.

This is the only source for how the student is actually doing. learnus_assignments
says whether something was submitted; this says what it scored. The gradebook category
weights are also the *enforced* grading breakdown, which sometimes differs from the
percentages printed in the syllabus PDF — trust this over the syllabus when they
disagree.

Items with no mark yet are shown with an em dash, which is how you tell "not graded
yet" from "scored zero". Courses whose instructor hides the gradebook simply do not
appear.

Reads the cache by default; pass refresh:true to re-scrape (a few seconds per course).`,
        {
          course: COURSE_ARG,
          gradedOnly: z
            .boolean()
            .optional()
            .describe("Show only items that have a mark, dropping the not-yet-graded skeleton."),
          refresh: REFRESH_ARG,
        },
        async (args) => {
          const { data, provenance } = await cacheFirst<Record<string, CourseGrades>>(
            "grades",
            args.refresh ?? false,
            async () => {
              const { context } = await getAuthenticatedContext();
              const courseMap = await getCourseMap(context);
              return scrapeGrades(context, courseMap);
            }
          );

          let courses = Object.values(data).sort((a, b) => a.code.localeCompare(b.code));
          if (args.course) {
            const upper = args.course.toUpperCase();
            courses = courses.filter((c) => c.code.toUpperCase() === upper);
          }
          if (args.gradedOnly) {
            courses = courses
              .map((c) => ({ ...c, items: c.items.filter((i) => i.grade !== null) }))
              .filter((c) => c.items.length > 0);
          }

          return textResult(`${provenance}\n\n${renderGrades(courses)}`);
        }
      ),

      tool(
        "learnus_syllabus",
        `Read the transcribed text of a course's syllabus or schedule document.

The sync downloads syllabus/schedule PDFs, DOCX and HWPX files from each course and
transcribes them to courses/<CODE>/syllabus.md. This tool reads that text — it
is the best source for grading breakdowns, attendance policy, required readings, exam
dates and week-by-week plans, none of which appear in the LMS activity list.

Pass a query to get only the matching passages instead of the whole document.`,
        {
          course: z.string().describe("Course code, e.g. UIC1581."),
          query: z
            .string()
            .optional()
            .describe("Optional keyword. Returns matching lines with surrounding context instead of the full text."),
        },
        async (args) => {
          const file = path.join(config.COURSES_DIR, args.course.toUpperCase(), "syllabus.md");
          if (!fs.existsSync(file)) {
            return textResult(
              `No transcribed syllabus for ${args.course.toUpperCase()}. Run learnus_sync to download and transcribe course documents, or check learnus_materials for the original file.`
            );
          }
          const text = fs.readFileSync(file, "utf-8");
          if (!args.query) {
            return textResult(
              text.length > 40_000
                ? `${text.slice(0, 40_000)}\n\n…truncated (${text.length} chars total). Use the query argument to search instead.`
                : text
            );
          }

          const needle = args.query.toLowerCase();
          const lines = text.split("\n");
          const keep = new Set<number>();
          lines.forEach((line, i) => {
            if (!line.toLowerCase().includes(needle)) return;
            for (let j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 3); j++) {
              keep.add(j);
            }
          });
          if (!keep.size) {
            return textResult(`No match for "${args.query}" in the ${args.course} syllabus.`);
          }
          const out = [...keep].sort((a, b) => a - b).map((i) => `${i + 1}: ${lines[i]}`);
          return textResult(out.join("\n"));
        }
      ),

      tool(
        "learnus_fetch_announcement",
        `Fetch the full body text and attachments of a single LearnUS announcement by URL.

Use after learnus_announcements gives you a title and URL. Always live — announcement
bodies are not cached.

The URL looks like https://ys.learnus.org/mod/ubboard/article.php?id=XXXXX&bwid=YYYYY`,
        {
          url: z.string().describe("Full LearnUS announcement URL (from learnus_announcements)"),
        },
        async (args) => {
          const { context } = await getAuthenticatedContext();
          const detail = await fetchSingleAnnouncement(context, args.url);
          let output = `CONTENT:\n${detail.content}`;
          if (detail.attachments.length > 0) {
            output += "\n\nATTACHMENTS:\n";
            for (const a of detail.attachments) output += `- ${a.name}: ${a.url}\n`;
          }
          return textResult(output);
        }
      ),

      tool(
        "learnus_fetch_url",
        `Authenticated GET of ANY LearnUS or Yonsei portal URL — a page or a file attachment.

This is the ONLY reliable way to read authenticated LMS content.

The general browser tools (browser_navigate and friends) are a different browser
with a different cookie jar. They are seeded with the LearnUS session when a fresh
one is cached, but that session lasts about 4 hours, so browser_* access to Yonsei
is best-effort and can silently stop working mid-conversation. When it lapses,
LearnUS answers with HTTP 200 and its login page rather than an error — a login
form that looks like a successful page load. This tool detects that and tells you
the session expired instead of handing you the login page. Prefer it for anything
on ys.learnus.org or ysrollbook.yonsei.ac.kr.

Pass any URL on: ys.learnus.org, www.learnus.org, learnus.org,
ysrollbook.yonsei.ac.kr, infra.yonsei.ac.kr. Other hosts are refused — use
web_surf for those.

Two behaviours, chosen automatically from what the server returns:
- A PAGE returns clean Markdown, every table rendered as Markdown, and the list of
  downloadable attachments found on it. Use this to read a Turnitin activity
  (mod/turnitintooltwo/view.php?id=...) — its part table with the real due dates is
  rendered by JavaScript and this tool waits for it.
- A FILE (pluginfile.php, mod/ubfile/view.php, anything served as a download) is
  downloaded through the authenticated session and its text extracted. PDF, DOCX,
  PPTX, HWPX, ODT, TXT, MD and CSV are supported. The file is also saved under the
  uploads tree and the path returned, so you can reference it later.

Typical flow: fetch a page, read its ATTACHMENTS list, then call this tool again
with an attachment URL to read the document itself.

If you get a "session expired" error, run any learnus_* tool with refresh:true to
force a fresh SSO login, then retry.`,
        {
          url: z
            .string()
            .describe("Full URL on ys.learnus.org or another allowed Yonsei host"),
          maxChars: z
            .number()
            .optional()
            .describe("Cap on returned text (default 20000)"),
          save: z
            .boolean()
            .optional()
            .describe("Save a downloaded attachment under the uploads tree (default true)"),
        },
        async (args) => {
          const { context } = await getAuthenticatedContext();
          const res = await fetchUrl(context, args.url, {
            maxChars: args.maxChars,
            save: args.save,
          });

          let output = `${res.kind === "file" ? "FILE" : "PAGE"}: ${res.title}\n`;
          output += `URL: ${res.finalUrl}\n`;
          if (res.contentType) output += `TYPE: ${res.contentType}\n`;
          if (res.bytes !== undefined) output += `SIZE: ${res.bytes} bytes\n`;
          if (res.savedTo) output += `SAVED: ${res.savedTo}\n`;
          if (res.extractionError) output += `EXTRACTION FAILED: ${res.extractionError}\n`;

          if (res.text) {
            output += `\nCONTENT${res.truncated ? " (truncated)" : ""}:\n${res.text}\n`;
          } else if (!res.extractionError) {
            output += `\nCONTENT: (no extractable text)\n`;
          }

          if (res.tables.length) {
            output += `\nTABLES (${res.tables.length}):\n`;
            for (const table of res.tables) output += `\n${table}\n`;
          }

          if (res.attachments.length) {
            output += `\nATTACHMENTS:\n`;
            for (const a of res.attachments) output += `- ${a.name}: ${a.url}\n`;
          }

          return textResult(output);
        }
      ),

      tool(
        "learnus_courses",
        `List the courses currently registered, merged from LearnUS enrollment and the academic portal timetable.

Returns per course: registration number (CODE-SS-NN), title, professor, room, delivery
format, period notation, Moodle course id, and which system it came from ("learnus",
"rollbook", or "both"). Courses registered in the portal but with no LearnUS page are
included — they are real classes that must be attended.

The enrolled list is discovered dynamically, never hardcoded, so it stays correct across
semesters. Reads the cache by default; refresh:true re-discovers live.`,
        { refresh: REFRESH_ARG },
        async (args) => {
          let courseMap: CourseMap | null = args.refresh ? null : loadCourseMap();
          let provenance = "Source: cached course map";
          if (!courseMap || Object.keys(courseMap).length === 0) {
            const { context } = await getAuthenticatedContext();
            courseMap = await discoverCourses(context);
            provenance = "Source: live discovery";
          }

          const lines = Object.values(courseMap)
            .sort((a, b) => (a.localCode ?? "").localeCompare(b.localCode ?? ""))
            .map((c) => {
              const where =
                c.format === "online" ? "online" : [c.building, c.room].filter(Boolean).join(" ");
              return [
                `${c.courseNo ?? c.localCode ?? "UNMAPPED"} — ${c.title ?? c.fullname}`,
                c.professor ? `prof ${c.professor}` : null,
                c.periodNotation || null,
                where || null,
                c.moodleId ? `moodleId ${c.moodleId}` : "no LearnUS page",
                `[${c.source}]`,
              ]
                .filter(Boolean)
                .join(" · ");
            });

          return textResult(
            `${provenance}\nCodes: ${activeCourseCodes(courseMap).join(", ")}\n\n${lines.join("\n")}`
          );
        }
      ),

      tool(
        "learnus_last_run",
        `Check when the background LMS sync last ran, how long it took, and which sources succeeded.

Returns the timestamp, duration, overall status (success / partial / failed), course
count, and a per-source breakdown — so you can tell whether, say, attendance is current
while announcements are not.

Check this before calling learnus_sync: if the cache is recent, just read the other
tools instead.`,
        {},
        async () => {
          const state = readSyncState();
          if (state) {
            const age = Date.now() - new Date(state.finishedAt).getTime();
            return textResult(
              `Last sync ${describeAge(age)} — ${state.status} in ${(state.durationMs / 1000).toFixed(1)}s, ${state.courseCount} courses.\n\n${JSON.stringify(state.steps, null, 2)}`
            );
          }
          if (fs.existsSync(config.LAST_RUN_FILE)) {
            return textResult(fs.readFileSync(config.LAST_RUN_FILE, "utf-8"));
          }
          return textResult("No sync has run yet. Call learnus_sync to populate the cache.");
        }
      ),
    ],
  });
}

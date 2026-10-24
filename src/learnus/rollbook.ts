/**
 * Yonsei 전자출결 (ysrollbook.yonsei.ac.kr) client.
 *
 * This module is the authority for two things LearnUS cannot answer:
 *
 *  1. The *official* timetable — meeting days, times, room, professor and
 *     delivery format. LearnUS only shows coursework, which is why a fully
 *     in-person class can look "asynchronous online" if you infer from it.
 *  2. Recorded attendance, per session, per course.
 *
 * Two endpoints do all the work, both discovered by live reconnaissance:
 *
 *   GET  /eams/student/atdc/atdcLst      → `table.tbl_col1` course roster
 *   POST /eams/student/atdc/atdcAllDtl   → `table.tbl_col9` per-session grids
 *        body: nowPage=&hyhg=<semester>&lecSeq=0&classDt=&progress=
 *
 * Note the endpoints named in the original brief do not exist:
 * `/local/ubion/attendance/index.php` 404s, and the Cleopatra portal
 * controller `/sch/sles/SlessyCtr/findAtnlcHandbList.do` is not a real path.
 */
import type { BrowserContext, Page } from "playwright";
import * as config from "./config.js";
import { logger } from "./logger.js";

export interface Meeting {
  /** Korean weekday character: 월 화 수 목 금 토 일 */
  day: string;
  /** English weekday name */
  dayEn: string;
  /** "09:00" */
  start: string;
  /** "10:50" */
  end: string;
  /** Yonsei period numbers covered, e.g. [1, 2] */
  periods: number[];
}

export type DeliveryFormat = "in-person" | "online" | "unknown";

export interface TimetableEntry {
  /** Full registration number, e.g. "UIC2101-08-00" */
  courseNo: string;
  /** Course code alone, e.g. "UIC2101" */
  code: string;
  /** Division/section, e.g. "08" */
  division: string;
  title: string;
  professor: string;
  building: string;
  room: string;
  format: DeliveryFormat;
  meetings: Meeting[];
  /** Compact Yonsei period notation, e.g. "수1, 금1,2" */
  periodNotation: string;
  enrollment: number | null;
}

export type SessionStatus =
  | "present"
  | "absent"
  | "late"
  | "early-leave"
  | "holiday"
  | "not-taken"
  | "future";

export interface AttendanceSession {
  /** ISO date, e.g. "2026-09-09" */
  date: string;
  /** Raw column label, e.g. "0909(수)" */
  label: string;
  day: string;
  status: SessionStatus;
  raw: string;
}

export interface AttendanceRecord {
  courseNo: string;
  code: string;
  division: string;
  title: string;
  present: number;
  late: number;
  absent: number;
  earlyLeave: number;
  /** Sessions that have actually happened and were graded. */
  heldSessions: number;
  /** Every non-holiday session in the term, including future ones. */
  plannedSessions: number;
  sessions: AttendanceSession[];
}

export interface AttendanceSummary {
  semester: string;
  fetchedAt: string;
  chapelSeat: string | null;
  totals: { present: number; late: number; absent: number; earlyLeave: number };
  courses: AttendanceRecord[];
}

const WEEKDAY_EN: Record<string, string> = {
  월: "Monday",
  화: "Tuesday",
  수: "Wednesday",
  목: "Thursday",
  금: "Friday",
  토: "Saturday",
  일: "Sunday",
};

/**
 * Yonsei period N runs from (N+8):00 to (N+8):50 — period 1 is 09:00-09:50,
 * period 7 is 15:00-15:50, and so on.
 */
function periodOf(hhmm: string): number {
  const hour = Number.parseInt(hhmm.slice(0, 2), 10);
  return hour - 8;
}

function periodsBetween(start: string, end: string): number[] {
  const first = periodOf(start);
  const last = periodOf(end);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return [];
  const out: number[] = [];
  for (let p = first; p <= last; p++) out.push(p);
  return out;
}

/** "화 12:00 - 12:50  목 13:00 - 14:50" → two Meetings. */
export function parseMeetings(raw: string): Meeting[] {
  const meetings: Meeting[] = [];
  const re = /([월화수목금토일])\s*(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const [, day, start, end] = m;
    meetings.push({
      day,
      dayEn: WEEKDAY_EN[day] ?? day,
      start,
      end,
      periods: periodsBetween(start, end),
    });
  }
  return meetings;
}

/** [{수,[1]},{금,[1,2]}] → "수1, 금1,2" */
export function periodNotation(meetings: Meeting[]): string {
  return meetings
    .filter((mt) => mt.periods.length > 0)
    .map((mt) => `${mt.day}${mt.periods.join(",")}`)
    .join(", ");
}

/**
 * "진리관B  I진B305" → in-person in room I진B305.
 * "기타  실시간온라인" → online (Yonsei files remote classes under building 기타).
 */
function parseRoom(raw: string): { building: string; room: string; format: DeliveryFormat } {
  const parts = raw.split(/\s{2,}|\t/).map((s) => s.trim()).filter(Boolean);
  const building = parts[0] ?? "";
  const room = parts.slice(1).join(" ");
  const combined = `${building} ${room}`;
  let format: DeliveryFormat = "unknown";
  if (/실시간온라인|온라인|원격|비대면|사이버/.test(combined)) format = "online";
  else if (room || building) format = "in-person";
  return { building, room, format };
}

function splitCourseNo(courseNo: string): { code: string; division: string } {
  const m = courseNo.match(/^([A-Z]{2,4}\d{4})-(\d{2})/);
  return { code: m?.[1] ?? courseNo, division: m?.[2] ?? "" };
}

/** Navigate to rollbook, letting the Yonsei SSO cookie log us in automatically. */
async function openRollbook(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${config.ROLLBOOK_BASE}/eams/student/main`, {
    waitUntil: "domcontentloaded",
    timeout: config.NAV_TIMEOUT,
  });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  return page;
}

/** Switch the roster page to a different semester via its search form. */
async function selectSemester(page: Page, semester: string): Promise<void> {
  const current = await page
    .$eval("#frmSch [name=hyhg]", (el) => (el as HTMLInputElement).value)
    .catch(() => null);
  if (current === semester) return;

  await page.evaluate((hyhg) => {
    const form = document.querySelector<HTMLFormElement>("#frmSch");
    if (!form) return;
    const input = form.querySelector<HTMLInputElement>("[name=hyhg]");
    if (input) input.value = hyhg;
    form.submit();
  }, semester);
  await page.waitForLoadState("domcontentloaded", { timeout: config.NAV_TIMEOUT }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
}

/**
 * The official timetable: every registered course with room, period, professor
 * and delivery format.
 */
export async function fetchTimetable(
  context: BrowserContext,
  semester = config.currentSemester()
): Promise<TimetableEntry[]> {
  logger.info(`Fetching rollbook timetable for semester ${semester}...`);
  const page = await openRollbook(context);
  try {
    await page.goto(`${config.ROLLBOOK_BASE}/eams/student/atdc/atdcLst`, {
      waitUntil: "domcontentloaded",
      timeout: config.NAV_TIMEOUT,
    });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await selectSemester(page, semester);

    const rows = await page.evaluate(() => {
      const out: string[][] = [];
      for (const table of Array.from(document.querySelectorAll("table.tbl_col1"))) {
        for (const tr of Array.from(table.querySelectorAll("tr"))) {
          const cells = Array.from(tr.querySelectorAll("td")).map((td) =>
            (td.textContent || "").replace(/\u00a0/g, " ").trim()
          );
          if (cells.length >= 5) out.push(cells);
        }
      }
      return out;
    });

    const entries: TimetableEntry[] = [];
    for (const cells of rows) {
      const courseNo = cells[0];
      if (!/^[A-Z]{2,4}\d{4}-\d{2}/.test(courseNo)) continue; // skips "검색 된 데이터가 없습니다."
      const { code, division } = splitCourseNo(courseNo);
      const { building, room, format } = parseRoom(cells[3] ?? "");
      const meetings = parseMeetings(cells[4] ?? "");
      const enrollment = Number.parseInt(cells[5] ?? "", 10);
      entries.push({
        courseNo,
        code,
        division,
        title: cells[1] ?? "",
        professor: cells[2] ?? "",
        building,
        room,
        format,
        meetings,
        periodNotation: periodNotation(meetings),
        enrollment: Number.isFinite(enrollment) ? enrollment : null,
      });
    }

    logger.info(`Rollbook timetable: ${entries.length} courses`);
    return entries;
  } finally {
    await page.close();
  }
}

function classifyStatus(raw: string): SessionStatus {
  const t = raw.trim();
  if (!t || t === "-") return "future";
  if (t.startsWith("출")) return "present";
  if (t.startsWith("결")) return "absent";
  if (t.startsWith("지")) return "late";
  if (t.startsWith("조")) return "early-leave";
  if (t.startsWith("휴")) return "holiday";
  if (t.startsWith("미")) return "not-taken";
  return "future";
}

/** "0909(수)" + semester "20262" → "2026-09-09". */
function labelToIso(label: string, semester: string): string {
  const m = label.match(/(\d{2})(\d{2})/);
  if (!m) return "";
  const year = Number.parseInt(semester.slice(0, 4), 10);
  const month = Number.parseInt(m[1], 10);
  // A fall term (term 2) that runs into Jan/Feb belongs to the following year.
  const term = semester.slice(4);
  const y = term === "2" && month <= 2 ? year + 1 : year;
  return `${y}-${m[1]}-${m[2]}`;
}

/** The Chapel seat assignment shown on the rollbook landing page. */
export async function fetchChapelSeat(context: BrowserContext): Promise<string | null> {
  const page = await openRollbook(context);
  try {
    const text = await page.evaluate(() => document.body.innerText || "");
    const m = text.match(/채플좌석\s*[:：]\s*([A-Za-z0-9-]+)/);
    return m?.[1] ?? null;
  } catch {
    return null;
  } finally {
    await page.close();
  }
}

/**
 * Full per-session attendance for every registered course.
 *
 * Triggers the page's own `ATTEND.viewAtdcAllDtail()`, which POSTs to
 * `/eams/student/atdc/atdcAllDtl` and re-renders one `table.tbl_col9` grid per
 * course: a header row of session dates plus a data row of status tokens.
 */
export async function fetchAttendance(
  context: BrowserContext,
  semester = config.currentSemester()
): Promise<AttendanceSummary> {
  logger.info(`Fetching rollbook attendance for semester ${semester}...`);
  const page = await openRollbook(context);
  try {
    let chapelSeat: string | null = null;
    try {
      const mainText = await page.evaluate(() => document.body.innerText || "");
      chapelSeat = mainText.match(/채플좌석\s*[:：]\s*([A-Za-z0-9-]+)/)?.[1] ?? null;
    } catch {
      /* seat is a nice-to-have */
    }

    await page.goto(`${config.ROLLBOOK_BASE}/eams/student/atdc/atdcLst`, {
      waitUntil: "domcontentloaded",
      timeout: config.NAV_TIMEOUT,
    });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await selectSemester(page, semester);

    // "전체 출결 현황" — expands every course into a per-session grid.
    await page.evaluate(() => {
      const w = window as unknown as { ATTEND?: { viewAtdcAllDtail?: () => void } };
      const progress = document.querySelector<HTMLInputElement>("#progress");
      if (progress) progress.value = "N";
      if (typeof w.ATTEND?.viewAtdcAllDtail === "function") {
        w.ATTEND.viewAtdcAllDtail();
      } else {
        document.querySelector<HTMLAnchorElement>("#viewAtdcAllDtailBtn a")?.click();
      }
    });
    await page.waitForSelector("table.tbl_col9", { timeout: 20000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

    const grids = await page.evaluate(() =>
      Array.from(document.querySelectorAll("table.tbl_col9")).map((table) => ({
        header: Array.from(table.querySelectorAll("tr")[0]?.querySelectorAll("th,td") ?? []).map(
          (c) => (c.textContent || "").replace(/\s+/g, " ").trim()
        ),
        data: Array.from(table.querySelectorAll("tr")[1]?.querySelectorAll("th,td") ?? []).map(
          (c) => (c.textContent || "").replace(/\s+/g, " ").trim()
        ),
      }))
    );

    const courses: AttendanceRecord[] = [];
    for (const grid of grids) {
      if (grid.header.length < 3 || grid.data.length < 3) continue;
      const titleCell = grid.data[0] ?? "";
      const m = titleCell.match(/^(.*?)\s*\(([A-Z]{2,4}\d{4}-\d{2}-\d{2})\)\s*$/);
      if (!m) continue;
      const [, title, courseNo] = m;
      const { code, division } = splitCourseNo(courseNo);

      const sessions: AttendanceSession[] = [];
      let present = 0;
      let late = 0;
      let absent = 0;
      let earlyLeave = 0;

      // Column 0 is the title, the final column is the 출/지/결/조 summary.
      for (let i = 1; i < grid.header.length - 1 && i < grid.data.length - 1; i++) {
        const label = grid.header[i];
        const raw = grid.data[i] ?? "";
        const status = classifyStatus(raw);
        sessions.push({
          date: labelToIso(label, semester),
          label,
          day: label.match(/\(([월화수목금토일])\)/)?.[1] ?? "",
          status,
          raw,
        });
        if (status === "present") present++;
        else if (status === "late") late++;
        else if (status === "absent") absent++;
        else if (status === "early-leave") earlyLeave++;
      }

      // Prefer the page's own 출/지/결/조 tally when present — it is authoritative.
      const tally = (grid.data[grid.data.length - 1] ?? "").match(
        /(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/
      );
      if (tally) {
        present = Number.parseInt(tally[1], 10);
        late = Number.parseInt(tally[2], 10);
        absent = Number.parseInt(tally[3], 10);
        earlyLeave = Number.parseInt(tally[4], 10);
      }

      courses.push({
        courseNo,
        code,
        division,
        title,
        present,
        late,
        absent,
        earlyLeave,
        heldSessions: present + late + absent + earlyLeave,
        plannedSessions: sessions.filter((s) => s.status !== "holiday").length,
        sessions,
      });
    }

    const totals = courses.reduce(
      (acc, c) => ({
        present: acc.present + c.present,
        late: acc.late + c.late,
        absent: acc.absent + c.absent,
        earlyLeave: acc.earlyLeave + c.earlyLeave,
      }),
      { present: 0, late: 0, absent: 0, earlyLeave: 0 }
    );

    logger.info(
      `Rollbook attendance: ${courses.length} courses, ${totals.absent} absence(s)`
    );
    return {
      semester,
      fetchedAt: new Date().toISOString(),
      chapelSeat,
      totals,
      courses,
    };
  } finally {
    await page.close();
  }
}

export interface AttendanceRisk {
  level: "ok" | "watch" | "warning" | "critical";
  /** Absences that would mean automatic failure under Yonsei's 1/3 rule. */
  failThreshold: number;
  message: string;
}

/**
 * Yonsei's standing rule is that missing more than one third of a course's
 * sessions is an automatic F. Three late arrivals are normally counted as one
 * absence.
 */
export function assessRisk(record: AttendanceRecord): AttendanceRisk {
  const planned = record.plannedSessions || record.heldSessions;
  const failThreshold = Math.floor(planned / 3);
  const effective = record.absent + Math.floor(record.late / 3);
  const ratio = failThreshold > 0 ? effective / failThreshold : 0;

  let level: AttendanceRisk["level"] = "ok";
  if (effective > failThreshold) level = "critical";
  else if (ratio >= 0.75) level = "warning";
  else if (ratio >= 0.4) level = "watch";

  const remaining = Math.max(0, failThreshold - effective);
  const message =
    level === "critical"
      ? `OVER THE LIMIT — ${effective} effective absences exceeds the ${failThreshold} allowed for ${planned} sessions. Contact the professor.`
      : `${effective}/${failThreshold} of the absence allowance used; ${remaining} more absence(s) before risking an F.`;

  return { level, failThreshold, message };
}

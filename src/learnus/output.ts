import fs from "node:fs";
import path from "node:path";
import * as config from "./config.js";
import { logger } from "./logger.js";
import type { Announcement } from "./scrapers/announcements.js";
import type { Assignment } from "./scrapers/assignments.js";
import type { Material } from "./scrapers/materials.js";
import type { CalendarEvent } from "./scrapers/calendar.js";
import type { CourseGrades } from "./scrapers/grades.js";
import { assessRisk, type AttendanceSummary, type TimetableEntry } from "./rollbook.js";

/**
 * Keyed by the union rather than an if/else so that adding an activity type is a
 * compile error here instead of a silently wrong icon.
 */
const ASSIGNMENT_ICONS: Record<Assignment["modname"], string> = {
  quiz: "\u{1F4DD}",
  assign: "\u{1F4CB}",
  turnitintooltwo: "\u{1F9FE}",
};

/**
 * The name key two sources must agree on for a deadline to count as one row.
 * Exported so the contract with `learnus_calendar`'s event naming is testable.
 */
export function normalizeItemName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\s+(is due|due|closes|opens|starts|stops|should be completed)$/g, "")
    .trim();
}

function formatBytes(bytes: number | undefined): string {
  if (!bytes) return "unknown";
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "KB";
  return (bytes / (1024 * 1024)).toFixed(1) + "MB";
}

export interface ScrapeResults {
  announcements: Record<string, Announcement[]>;
  assignments: Record<string, Assignment[]>;
  materials: Record<string, Material[]>;
  calendar: Record<string, CalendarEvent[]>;
  grades?: Record<string, CourseGrades>;
  timetable?: TimetableEntry[];
  attendance?: AttendanceSummary;
}

/**
 * The set of course codes present in this scrape. Derived from the data itself
 * rather than a hardcoded per-semester list, so a new term needs no code edit.
 */
function collectCodes(data: ScrapeResults): string[] {
  const codes = new Set<string>([
    ...Object.keys(data.announcements),
    ...Object.keys(data.assignments),
    ...Object.keys(data.materials),
    ...Object.keys(data.calendar),
    ...Object.keys(data.grades ?? {}),
  ]);
  for (const entry of data.timetable ?? []) codes.add(entry.code);
  for (const record of data.attendance?.courses ?? []) codes.add(record.code);
  codes.delete("general");
  return [...codes].sort();
}

export function writeScrapedData(data: ScrapeResults): void {
  const timestamp = new Date().toISOString();
  const { announcements, assignments, materials, calendar } = data;
  const grades = data.grades ?? {};

  for (const code of collectCodes(data)) {
    const courseDir = path.join(config.COURSES_DIR, code);
    fs.mkdirSync(courseDir, { recursive: true });

    // Announcements
    if (announcements[code]?.length) {
      fs.writeFileSync(
        path.join(courseDir, "announcements.json"),
        JSON.stringify({ lastUpdated: timestamp, items: announcements[code] }, null, 2)
      );

      let md = `# ${code} Announcements\n_Last scraped: ${timestamp}_\n\n`;
      for (const a of announcements[code]) {
        md += `### ${a.title}\n`;
        md += `- **Date:** ${a.date}\n`;
        md += `- **Author:** ${a.author}\n`;
        if (a.url) md += `- **Link:** ${a.url}\n`;
        md += "\n";
      }
      fs.writeFileSync(path.join(courseDir, "announcements.md"), md);
    }

    // Assignments & Deadlines
    if (assignments[code]?.length) {
      fs.writeFileSync(
        path.join(courseDir, "deadlines.json"),
        JSON.stringify({ lastUpdated: timestamp, items: assignments[code] }, null, 2)
      );

      let md = `# ${code} Assignments & Deadlines\n_Last scraped: ${timestamp}_\n\n`;
      for (const a of assignments[code]) {
        const icon = ASSIGNMENT_ICONS[a.modname] ?? "\u{1F4CB}";
        md += `### ${icon} ${a.name}\n`;
        md += `- **Type:** ${a.modname}\n`;
        md += `- **Section:** ${a.section || "N/A"}\n`;
        md += `- **Due:** ${a.dueDate || "Not set"}\n`;
        md += `- **Status:** ${a.status || "Unknown"}\n`;
        if (a.url) md += `- **Link:** ${a.url}\n`;
        md += "\n";
      }
      fs.writeFileSync(path.join(courseDir, "deadlines.md"), md);
    }

    // Materials
    if (materials[code]?.length) {
      fs.writeFileSync(
        path.join(courseDir, "materials.json"),
        JSON.stringify({ lastUpdated: timestamp, items: materials[code] }, null, 2)
      );

      // Rows found in the weekly section text are kept in their own table. The
      // system prompt points the agent at this file to answer academic
      // questions, and a course can contribute 50+ such links — inlining them
      // with the modules would bury the module list they came to read.
      const moduleItems = materials[code].filter((m) => m.source !== "section-summary");
      const summaryItems = materials[code].filter((m) => m.source === "section-summary");

      let md = `# ${code} Course Materials\n_Last scraped: ${timestamp}_\n\n`;
      for (const m of moduleItems) {
        md += `### ${m.name} (${m.type})\n`;
        md += `- **Section:** ${m.section || "N/A"}\n`;
        if (m.files?.length) {
          md += `- **Files:**\n`;
          for (const f of m.files) {
            md += `  - ${f.filename} (${formatBytes(f.filesize)})\n`;
          }
        }
        if (m.url) md += `- **Link:** ${m.url}\n`;
        md += "\n";
      }

      if (summaryItems.length) {
        md += `## Links posted in section descriptions\n\n`;
        md += `_${summaryItems.length} link(s) the instructor wrote into the week/topic text`;
        md += ` rather than uploading as files. Readings often live here and nowhere else._\n\n`;
        md += "| Section | Name | Link |\n|---------|------|------|\n";
        for (const m of summaryItems) {
          const name = m.name.replace(/\|/g, "/");
          md += `| ${m.section || "—"} | ${name} | ${m.url} |\n`;
        }
        md += "\n";
      }

      fs.writeFileSync(path.join(courseDir, "materials.md"), md);
    }

    // Calendar events
    if (calendar[code]?.length) {
      fs.writeFileSync(
        path.join(courseDir, "upcoming-events.json"),
        JSON.stringify({ lastUpdated: timestamp, items: calendar[code] }, null, 2)
      );
    }

    // Gradebook
    if (grades[code]?.items.length) {
      fs.writeFileSync(
        path.join(courseDir, "grades.md"),
        renderCourseGrades(grades[code], timestamp)
      );
    }
  }

  if (data.timetable?.length) writeTimetable(data.timetable, timestamp);
  if (data.attendance) writeAttendance(data.attendance, timestamp);

  // Combined upcoming summary
  writeUpcomingSummary(assignments, calendar, timestamp);
  writeGradeSummary(grades, timestamp);
  logger.info("Output files written successfully");
}

/**
 * The official timetable, straight from 전자출결 — the authority on where to be.
 *
 * Markdown only. The machine-readable copy lives in `data/timetable.json` and
 * is written by the sync; emitting a second JSON here would give us two files
 * that can silently disagree about which room a class is in.
 */
function writeTimetable(timetable: TimetableEntry[], timestamp: string): void {
  let md = `# Official Timetable (연세 전자출결)\n_Auto-generated: ${timestamp}_\n\n`;
  md += "| Course | Title | Professor | Room | Format | Periods | Times |\n";
  md += "|--------|-------|-----------|------|--------|---------|-------|\n";
  for (const e of timetable) {
    const times = e.meetings
      .map((m) => `${m.day} ${m.start}-${m.end}`)
      .join("<br>");
    const room = e.format === "online" ? "실시간온라인 (online)" : `${e.building} ${e.room}`;
    md += `| ${e.courseNo} | ${e.title} | ${e.professor} | ${room} | ${e.format} | ${e.periodNotation} | ${times} |\n`;
  }

  md += "\n## Weekly Grid\n\n";
  const days = ["월", "화", "수", "목", "금"];
  for (const day of days) {
    const slots = timetable
      .flatMap((e) => e.meetings.filter((m) => m.day === day).map((m) => ({ e, m })))
      .sort((a, b) => a.m.start.localeCompare(b.m.start));
    if (!slots.length) continue;
    md += `**${day}요일**\n`;
    for (const { e, m } of slots) {
      const where = e.format === "online" ? "online" : `${e.building} ${e.room}`;
      md += `- ${m.start}–${m.end} · ${e.title} (${e.courseNo}) · ${where}\n`;
    }
    md += "\n";
  }

  fs.writeFileSync(path.join(config.COURSES_DIR, "timetable.md"), md);
}

/**
 * Attendance plus an explicit read on how close each course is to the F line.
 * Markdown only — see `writeTimetable` for why there is no JSON twin here.
 */
function writeAttendance(attendance: AttendanceSummary, timestamp: string): void {
  const t = attendance.totals;
  let md = `# Attendance (연세 전자출결)\n_Auto-generated: ${timestamp}_\n\n`;
  md += `**Semester:** ${attendance.semester}  \n`;
  if (attendance.chapelSeat) md += `**Chapel seat:** ${attendance.chapelSeat}  \n`;
  md += `**Overall:** ${t.present} present · ${t.late} late · ${t.absent} absent · ${t.earlyLeave} early leave\n\n`;

  md += "| Course | Title | Present | Late | Absent | Early | Risk |\n";
  md += "|--------|-------|---------|------|--------|-------|------|\n";
  for (const c of attendance.courses) {
    const risk = assessRisk(c);
    md += `| ${c.courseNo} | ${c.title} | ${c.present} | ${c.late} | ${c.absent} | ${c.earlyLeave} | ${risk.level} (${risk.message}) |\n`;
  }

  const flagged = attendance.courses.filter((c) => c.absent > 0 || c.late > 0);
  if (flagged.length) {
    md += "\n## Missed / Late Sessions\n\n";
    for (const c of flagged) {
      const bad = c.sessions.filter(
        (s) => s.status === "absent" || s.status === "late" || s.status === "early-leave"
      );
      if (!bad.length) continue;
      md += `**${c.code} — ${c.title}**\n`;
      for (const s of bad) md += `- ${s.date} (${s.day}) — ${s.status}\n`;
      md += "\n";
    }
  }

  fs.writeFileSync(path.join(config.COURSES_DIR, "attendance.md"), md);
}

/**
 * Parse either representation of a deadline into an instant.
 *
 * Calendar events carry a real ISO 8601 timestamp. The assignment scraper reads
 * what LearnUS renders, which is a naive "2026-09-26 00:00" already in Seoul
 * time (sometimes prefixed "on "). Passing that to `new Date` on a UTC server
 * shifts every assignment deadline nine hours later than it really is, so the
 * zone has to be supplied explicitly.
 */
function toInstant(raw: string): number | null {
  if (/\dT\d/.test(raw) && /(Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : null;
  }
  const m = raw.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+09:00`);
  return Number.isFinite(t) ? t : null;
}

/**
 * Everything still ahead, in one table.
 *
 * The calendar window now reaches a month into the past, so this filters to
 * future events — a summary titled "upcoming" that lists last month's quizzes
 * is worse than no summary. Assignment rows and calendar rows describing the
 * same deadline are collapsed on (course, date, normalised name).
 */
function writeUpcomingSummary(
  assignments: Record<string, Assignment[]>,
  calendar: Record<string, CalendarEvent[]>,
  timestamp: string
): void {
  const summaryPath = path.join(config.COURSES_DIR, "upcoming-summary.md");
  let md = `# Upcoming Deadlines & Events\n_Auto-generated: ${timestamp}_\n\n`;

  interface Row {
    course: string;
    name: string;
    date: string;
    instant: number;
    type: string;
    status?: string | null;
  }
  const rows: Row[] = [];
  const now = Date.now();
  const seen = new Set<string>();

  const push = (row: Omit<Row, "instant">) => {
    const instant = toInstant(row.date);
    if (instant === null || instant < now) return;
    // "Quiz 3 on 1.3 closes" and "Quiz 3 on 1.3" are the same deadline.
    //
    // Calendar instants come from epoch seconds; Turnitin part instants come
    // from a minute-precision rendered string. Bucketing to the minute stops a
    // stray :30 in the event record from splitting one deadline into two rows.
    const key = `${row.course}|${normalizeItemName(row.name)}|${Math.floor(instant / 60_000)}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ ...row, instant });
  };

  for (const code of new Set([...Object.keys(assignments), ...Object.keys(calendar)])) {
    for (const a of assignments[code] ?? []) {
      if (a.dueDate) {
        push({ course: code, name: a.name, date: a.dueDate, type: a.modname, status: a.status });
      }
    }
    for (const e of calendar[code] ?? []) {
      if (!e.timestart) continue;
      push({
        course: code,
        name: e.name,
        date: e.timestart,
        type: e.modname ? `${e.modname}/${e.eventtype}` : e.eventtype,
        status: e.actionable ? "action required" : null,
      });
    }
  }

  rows.sort((a, b) => a.instant - b.instant);

  if (rows.length === 0) {
    md += "_No upcoming items found._\n";
  } else {
    md += "| Course | Item | Type | Date (KST) | Status |\n";
    md += "|--------|------|------|------------|--------|\n";
    for (const row of rows) {
      const when = new Date(row.instant).toLocaleString("en-GB", {
        timeZone: "Asia/Seoul",
        dateStyle: "medium",
        timeStyle: "short",
      });
      const name = row.name.replace(/\s+/g, " ").trim();
      md += `| ${row.course} | ${name} | ${row.type} | ${when} | ${row.status || "-"} |\n`;
    }
  }

  fs.writeFileSync(summaryPath, md);
}

/** One course's gradebook, category tree preserved. */
function renderCourseGrades(course: CourseGrades, timestamp: string): string {
  let md = `# ${course.code} Grades — ${course.title}\n_Last scraped: ${timestamp}_\n\n`;
  md += `Source: ${course.url}\n\n`;
  md += "| Item | Category | Weight | Grade | Contribution | Feedback |\n";
  md += "|------|----------|--------|-------|--------------|----------|\n";
  for (const i of course.items) {
    const name = i.isTotal ? `**${i.name}**` : i.name;
    md += `| ${name} | ${i.category ?? "-"} | ${i.weight ?? "-"} | ${i.grade ?? "-"} | ${i.contribution ?? "-"} | ${(i.feedback ?? "-").replace(/\|/g, "/")} |\n`;
  }
  if (course.courseTotal) md += `\n**Course total:** ${course.courseTotal}\n`;
  return md;
}

/** One table across every course — the "how am I doing overall" view. */
function writeGradeSummary(
  grades: Record<string, CourseGrades>,
  timestamp: string
): void {
  const courses = Object.values(grades).sort((a, b) => a.code.localeCompare(b.code));
  let md = `# Gradebook Summary\n_Auto-generated: ${timestamp}_\n\n`;

  if (!courses.length) {
    md += "_No gradebook data available._\n";
  } else {
    md += "| Course | Title | Graded items | Course total |\n";
    md += "|--------|-------|--------------|--------------|\n";
    for (const c of courses) {
      md += `| ${c.code} | ${c.title} | ${c.gradedCount} | ${c.courseTotal ?? "-"} |\n`;
    }

    md += "\n## Returned marks\n\n";
    let any = false;
    for (const c of courses) {
      const marked = c.items.filter((i) => !i.isTotal && i.grade !== null);
      if (!marked.length) continue;
      any = true;
      md += `**${c.code} — ${c.title}**\n`;
      for (const i of marked) {
        md += `- ${i.name}: ${i.grade}`;
        if (i.weight) md += ` (weight ${i.weight})`;
        if (i.feedback) md += ` — ${i.feedback}`;
        md += "\n";
      }
      md += "\n";
    }
    if (!any) md += "_Nothing graded yet this term._\n";
  }

  fs.writeFileSync(path.join(config.COURSES_DIR, "grades.md"), md);
}

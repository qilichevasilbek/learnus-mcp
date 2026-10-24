/**
 * One full refresh of everything this server knows about coursework.
 *
 * This is the only place a complete scrape happens. It runs out-of-band — from
 * a scheduled `learnus-mcp sync` (cron, launchd, systemd), not inside a chat
 * turn — and writes normalized JSON to the cache directory plus the human-readable Markdown under each course
 * directory. The MCP tools then answer from that cache in milliseconds instead
 * of each one paying for its own browser launch and SSO round-trip.
 *
 * Every step is attempted independently. A LearnUS outage must not cost us the
 * portal timetable, and an unparseable syllabus must not cost us attendance.
 */
import type { BrowserContext } from "playwright";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as browser from "./browser.js";
import { login } from "./auth.js";
import { MoodleAPI } from "./moodle-api.js";
import * as config from "./config.js";
import { logger } from "./logger.js";
import { writeCache, writeSyncState, type SyncState } from "./cache.js";
import { discoverCourses, loadCourseMap, type CourseMap } from "./scrapers/courses.js";
import { scrapeAnnouncements } from "./scrapers/announcements.js";
import { scrapeAssignments } from "./scrapers/assignments.js";
import { scrapeMaterials } from "./scrapers/materials.js";
import { scrapeGrades } from "./scrapers/grades.js";
import { scrapeCalendarEvents } from "./scrapers/calendar.js";
import { fetchTimetable, fetchAttendance } from "./rollbook.js";
import { collectSyllabuses } from "./syllabus.js";
import { writeScrapedData } from "./output.js";

export interface SyncOptions {
  semester?: string;
  /** Re-discover the course list even if the cached map is fresh. */
  rediscover?: boolean;
  /** Skip syllabus download/extraction (the slowest step). */
  skipSyllabus?: boolean;
  /** Leave the shared browser open for the caller to reuse. */
  keepBrowserOpen?: boolean;
}

const COURSE_MAP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function acquireSyncLock(): () => void {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  const token = randomUUID();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(config.SYNC_LOCK_FILE, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }));
      return () => {
        try {
          fs.closeSync(fd);
          const owner = JSON.parse(fs.readFileSync(config.SYNC_LOCK_FILE, "utf8")) as { token?: string };
          if (owner.token === token) fs.unlinkSync(config.SYNC_LOCK_FILE);
        } catch {
          // The lock is best-effort cleanup; ownership prevents removing a successor's lock.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let ownerPid = 0;
      try {
        ownerPid = Number((JSON.parse(fs.readFileSync(config.SYNC_LOCK_FILE, "utf8")) as { pid?: number }).pid);
      } catch {
        // A truncated owner file can only come from a process that died while acquiring it.
      }
      if (ownerPid > 0) {
        try {
          process.kill(ownerPid, 0);
          throw new Error(`An LMS sync is already running (pid ${ownerPid}).`);
        } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
        }
      }
      fs.unlinkSync(config.SYNC_LOCK_FILE);
    }
  }
  throw new Error("Could not acquire the LMS sync lock.");
}

/** Run one step, recording success or failure without aborting the sync. */
async function step<T>(
  steps: SyncState["steps"],
  name: string,
  fn: () => Promise<T>,
  count?: (value: T) => number
): Promise<T | null> {
  try {
    const value = await fn();
    steps[name] = { ok: true, ...(count ? { count: count(value) } : {}) };
    return value;
  } catch (e) {
    const error = (e as Error).message;
    steps[name] = { ok: false, error };
    logger.error(`Sync step "${name}" failed: ${error}`);
    return null;
  }
}

async function resolveCourseMap(
  context: BrowserContext,
  semester: string,
  rediscover: boolean
): Promise<CourseMap> {
  if (!rediscover) {
    const cached = loadCourseMap();
    if (cached && Object.keys(cached).length > 0) {
      try {
        const fs = await import("node:fs");
        const age = Date.now() - fs.statSync(config.COURSE_MAP_FILE).mtimeMs;
        if (age < COURSE_MAP_TTL_MS) return cached;
      } catch {
        /* fall through to discovery */
      }
    }
  }
  return discoverCourses(context, { semester });
}

export async function runSync(opts: SyncOptions = {}): Promise<SyncState> {
  const {
    semester = config.currentSemester(),
    rediscover = false,
    skipSyllabus = false,
    keepBrowserOpen = false,
  } = opts;

  const startedAt = new Date();
  const steps: SyncState["steps"] = {};
  let courseCount = 0;
  let fatal: string | undefined;
  const releaseSyncLock = acquireSyncLock();

  logger.info(`=== LMS sync starting (semester ${semester}) ===`);

  try {
    const { context } = await browser.launch();
    const sesskey = await login(context);
    if (!sesskey) throw new Error("LearnUS authentication failed");

    const courseMap = await resolveCourseMap(context, semester, rediscover);
    courseCount = Object.keys(courseMap).length;
    steps.courses = { ok: true, count: courseCount };
    writeCache("courses", courseMap, semester);

    // The portal is the authority for where and when a class actually meets,
    // so it runs first and independently of anything LearnUS does.
    const timetable = await step(
      steps,
      "timetable",
      () => fetchTimetable(context, semester),
      (t) => t.length
    );
    if (timetable) writeCache("timetable", timetable, semester);

    const attendance = await step(steps, "attendance", () =>
      fetchAttendance(context, semester)
    );
    if (attendance) writeCache("attendance", attendance, semester);

    const announcements = await step(
      steps,
      "announcements",
      () => scrapeAnnouncements(context, courseMap),
      (a) => Object.values(a).flat().length
    );
    if (announcements) writeCache("announcements", announcements, semester);

    const assignments = await step(
      steps,
      "assignments",
      () => scrapeAssignments(context, courseMap),
      (a) => Object.values(a).flat().length
    );
    if (assignments) writeCache("assignments", assignments, semester);

    const materials = await step(
      steps,
      "materials",
      () => scrapeMaterials(context, courseMap),
      (m) => Object.values(m).flat().length
    );
    if (materials) writeCache("materials", materials, semester);

    const grades = await step(
      steps,
      "grades",
      () => scrapeGrades(context, courseMap),
      (g) => Object.values(g).reduce((n, c) => n + c.gradedCount, 0)
    );
    if (grades) writeCache("grades", grades, semester);

    const api = new MoodleAPI(context, sesskey);
    // A month either side of today plus two ahead: enough to answer "what did I
    // miss last week" and "what is coming in October" without a live request.
    const calendar = await step(
      steps,
      "calendar",
      () => scrapeCalendarEvents(api, courseMap, { monthsBack: 1, monthsAhead: 2 }),
      (c) => Object.values(c).flat().length
    );
    await api.close().catch(() => {});
    if (calendar) writeCache("calendar", calendar, semester);

    if (!skipSyllabus && materials) {
      await step(
        steps,
        "syllabus",
        () => collectSyllabuses(context, materials),
        (docs) => docs.filter((d) => d.ok).length
      );
    }

    // Markdown output is regenerated from whatever succeeded; a failed step
    // contributes an empty map rather than wiping the previous file.
    await step(steps, "write", async () =>
      writeScrapedData({
        announcements: announcements ?? {},
        assignments: assignments ?? {},
        materials: materials ?? {},
        calendar: calendar ?? {},
        grades: grades ?? {},
        timetable: timetable ?? undefined,
        attendance: attendance ?? undefined,
      })
    );
  } catch (e) {
    fatal = (e as Error).message;
    logger.error(`Sync aborted: ${fatal}`);
  } finally {
    if (!keepBrowserOpen) await browser.close().catch(() => {});
    releaseSyncLock();
  }

  const finishedAt = new Date();
  const failures = Object.values(steps).filter((s) => !s.ok).length;
  const state: SyncState = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    status: fatal ? "failed" : failures > 0 ? "partial" : "success",
    semester,
    courseCount,
    steps,
    ...(fatal ? { error: fatal } : {}),
  };

  writeSyncState(state);
  logger.info(
    `=== LMS sync ${state.status} in ${(state.durationMs / 1000).toFixed(1)}s ` +
      `(${courseCount} courses, ${failures} failed step(s)) ===`
  );
  return state;
}

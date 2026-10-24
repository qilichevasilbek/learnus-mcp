import fs from "node:fs";
import type { BrowserContext } from "playwright";
import * as config from "../config.js";
import { logger } from "../logger.js";
import {
  fetchTimetable,
  type DeliveryFormat,
  type Meeting,
  type TimetableEntry,
} from "../rollbook.js";

export interface CourseInfo {
  /** LearnUS/Moodle course id. Null for courses that exist only in the portal. */
  moodleId: number | null;
  fullname: string;
  /** Bare course code, e.g. "UIC2101". Derived, never hardcoded. */
  localCode: string | null;
  /** Section/division, e.g. "08". */
  division: string | null;
  /** Official registration number, e.g. "UIC2101-08-00". */
  courseNo: string | null;
  title: string | null;
  professor: string | null;
  building: string | null;
  room: string | null;
  format: DeliveryFormat | null;
  /** Yonsei period notation, e.g. "수1, 금1,2". */
  periodNotation: string | null;
  meetings: Meeting[];
  viewUrl: string | null;
  source: "learnus" | "rollbook" | "both";
}

export type CourseMap = Record<string, CourseInfo>;

/**
 * Pull the course code out of a course title.
 *
 * LearnUS writes "CRITICAL REASONING (UIC2101.08-00)" while the portal writes
 * "UIC2101-08-00", so both separators are accepted. This replaces the old
 * hardcoded per-semester code list, which silently went stale every term.
 */
export function parseCourseNo(
  text: string
): { code: string; division: string; courseNo: string } | null {
  const m = text.match(/\(?\b([A-Z]{2,4}\d{4})[.\-](\d{2})-(\d{2})\)?/);
  if (!m) return null;
  return { code: m[1], division: m[2], courseNo: `${m[1]}-${m[2]}-${m[3]}` };
}

/** Strip the trailing "(CODE.NN-NN)" so we are left with a human title. */
function cleanTitle(fullname: string): string {
  return fullname.replace(/\s*\(?\b[A-Z]{2,4}\d{4}[.\-]\d{2}-\d{2}\)?\s*$/, "").trim();
}

export async function discoverCourses(
  context: BrowserContext,
  opts: { includePortal?: boolean; semester?: string } = {}
): Promise<CourseMap> {
  const { includePortal = true, semester = config.currentSemester() } = opts;
  logger.info("Discovering enrolled courses...");

  const courses = await scrapeCoursesFromUbion(context);
  const courseMap: CourseMap = {};

  for (const course of courses) {
    const parsed = parseCourseNo(course.fullname);
    courseMap[String(course.id)] = {
      moodleId: course.id,
      fullname: course.fullname,
      localCode: parsed?.code ?? null,
      division: parsed?.division ?? null,
      courseNo: parsed?.courseNo ?? null,
      title: cleanTitle(course.fullname) || course.fullname,
      professor: null,
      building: null,
      room: null,
      format: null,
      periodNotation: null,
      meetings: [],
      viewUrl: `${config.LEARNUS_BASE}/course/view.php?id=${course.id}`,
      source: "learnus",
    };
    logger.info(
      `  LearnUS: ${course.fullname} (ID: ${course.id}) -> ${parsed?.code ?? "UNMAPPED"}`
    );
  }

  if (includePortal) {
    let timetable: TimetableEntry[] = [];
    try {
      timetable = await fetchTimetable(context, semester);
    } catch (e) {
      logger.warn(`  Portal timetable unavailable: ${(e as Error).message}`);
    }

    for (const entry of timetable) {
      const existing = Object.values(courseMap).find(
        (c) => c.courseNo === entry.courseNo || c.localCode === entry.code
      );
      if (existing) {
        existing.professor = entry.professor;
        existing.building = entry.building;
        existing.room = entry.room;
        existing.format = entry.format;
        existing.periodNotation = entry.periodNotation;
        existing.meetings = entry.meetings;
        existing.courseNo ??= entry.courseNo;
        existing.localCode ??= entry.code;
        existing.division ??= entry.division;
        existing.source = "both";
        continue;
      }

      // Registered in the portal but absent from LearnUS — still a real class
      // the student has to attend, so it must not be dropped.
      courseMap[entry.courseNo] = {
        moodleId: null,
        fullname: `${entry.title} (${entry.courseNo})`,
        localCode: entry.code,
        division: entry.division,
        courseNo: entry.courseNo,
        title: entry.title,
        professor: entry.professor,
        building: entry.building,
        room: entry.room,
        format: entry.format,
        periodNotation: entry.periodNotation,
        meetings: entry.meetings,
        viewUrl: null,
        source: "rollbook",
      };
      logger.info(`  Portal-only course: ${entry.courseNo} ${entry.title}`);
    }
  }

  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  fs.writeFileSync(config.COURSE_MAP_FILE, JSON.stringify(courseMap, null, 2));
  logger.info(`Course map saved: ${Object.keys(courseMap).length} courses`);

  return courseMap;
}

interface RawCourse {
  id: number;
  fullname: string;
  href: string;
}

async function scrapeCoursesFromUbion(
  context: BrowserContext
): Promise<RawCourse[]> {
  const page = await context.newPage();

  try {
    await page.goto(
      config.LEARNUS_BASE + "/local/ubion/user/index.php",
      { waitUntil: "domcontentloaded", timeout: config.NAV_TIMEOUT }
    );
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    let courseLinks: RawCourse[] = await page.$$eval(
      "a.coursefullname",
      (links) =>
        links
          .map((a) => {
            const idMatch = (a as HTMLAnchorElement).href.match(/id=(\d+)/);
            return {
              id: idMatch ? parseInt(idMatch[1]) : 0,
              fullname: a.textContent?.trim() ?? "",
              href: (a as HTMLAnchorElement).href,
            };
          })
          .filter((c) => c.id > 0)
    );

    if (courseLinks.length === 0) {
      const genericLinks: RawCourse[] = await page.$$eval(
        'a[href*="/course/view.php?id="]',
        (links) =>
          links
            .map((a) => {
              const idMatch = (a as HTMLAnchorElement).href.match(/id=(\d+)/);
              return {
                id: idMatch ? parseInt(idMatch[1]) : 0,
                fullname: a.textContent?.trim() ?? "",
                href: (a as HTMLAnchorElement).href,
              };
            })
            .filter((c) => c.id > 0 && c.fullname.length > 3)
      );

      const seen = new Set<number>();
      for (const link of genericLinks) {
        if (!seen.has(link.id)) {
          seen.add(link.id);
          courseLinks.push(link);
        }
      }
    }

    logger.info(`Found ${courseLinks.length} courses on 학위과정 page`);
    return courseLinks;
  } finally {
    await page.close();
  }
}

export function loadCourseMap(): CourseMap | null {
  if (!fs.existsSync(config.COURSE_MAP_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(config.COURSE_MAP_FILE, "utf-8")) as CourseMap;
  } catch {
    return null;
  }
}

/** The distinct course codes currently enrolled — replaces LOCAL_COURSE_CODES. */
export function activeCourseCodes(courseMap: CourseMap): string[] {
  const codes = new Set<string>();
  for (const course of Object.values(courseMap)) {
    if (course.localCode) codes.add(course.localCode);
  }
  return [...codes].sort();
}

/** A course that has a real LearnUS page, so its content can be scraped. */
export interface LearnusCourse extends CourseInfo {
  moodleId: number;
  localCode: string;
  viewUrl: string;
}

/** Courses that actually have a LearnUS page and can therefore be scraped. */
export function learnusCourses(courseMap: CourseMap): LearnusCourse[] {
  return Object.values(courseMap).filter(
    (c): c is LearnusCourse =>
      typeof c.moodleId === "number" && !!c.localCode && !!c.viewUrl
  );
}

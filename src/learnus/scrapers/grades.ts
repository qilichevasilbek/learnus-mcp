/**
 * Marks actually recorded in the LearnUS gradebook.
 *
 * Nothing else here answers "how am I doing". Assignments give due
 * dates and a submitted/not-submitted flag; this gives the score that came
 * back, the weight the item carries, the instructor's feedback, and the
 * gradebook category tree — which is where a syllabus's grading breakdown is
 * actually enforced, whatever the syllabus PDF claims.
 *
 * Moodle's web-service API for this (`gradereport_overview_get_course_grades`)
 * is disabled on this install, so the user report page is parsed instead. Its
 * `column-*` cell classes are stable across Moodle themes, so the parser keys
 * off those rather than column position.
 */
import type { BrowserContext } from "playwright";
import * as config from "../config.js";
import { logger } from "../logger.js";
import type { CourseMap } from "./courses.js";

export interface GradeItem {
  name: string;
  /** Gradebook category this item sits under, e.g. "Assignments". */
  category: string | null;
  /** Percentage of the final course mark, as Moodle renders it ("7.69 %"). */
  weight: string | null;
  /** Score received, or null when nothing is graded yet. */
  grade: string | null;
  range: string | null;
  percentage: string | null;
  feedback: string | null;
  contribution: string | null;
  /** True for the "<Category> total" and "Course total" summary rows. */
  isTotal: boolean;
}

export interface CourseGrades {
  code: string;
  title: string;
  moodleId: number;
  url: string;
  items: GradeItem[];
  /** The "Course total" row's grade, when the gradebook exposes one. */
  courseTotal: string | null;
  /** Items with a recorded mark, i.e. work that has actually been returned. */
  gradedCount: number;
}

const CLEAN = (s: string | undefined | null): string | null => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t && t !== "-" ? t : null;
};

/**
 * Moodle stores some gradebook item names form-encoded, so a category arrives
 * as "Attendance+and+Class+attitude". Only rewritten when the name has no real
 * spaces at all, so a legitimate "Quiz 1 + 2" is left alone.
 */
const DECODE = (s: string | null): string | null =>
  s && s.includes("+") && !s.includes(" ") ? s.replace(/\+/g, " ") : s;

/** Scrape one course's user grade report. */
export async function scrapeCourseGrades(
  context: BrowserContext,
  moodleId: number
): Promise<Omit<CourseGrades, "code" | "title">> {
  const url = `${config.LEARNUS_BASE}/grade/report/user/index.php?id=${moodleId}`;
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.NAV_TIMEOUT });

    const rows = await page.evaluate(() => {
      const table =
        document.querySelector("table.user-grade") ??
        document.querySelector("table.gradereport-user");
      if (!table) return [] as Array<Record<string, string>>;

      return [...table.querySelectorAll("tbody tr")].map((tr) => {
        const row: Record<string, string> = {};
        for (const cell of tr.querySelectorAll("th,td")) {
          const column = [...cell.classList].find((c) => c.startsWith("column-"));
          if (!column) continue;
          row[column.slice("column-".length)] = (cell as HTMLElement).innerText ?? "";
        }
        return row;
      });
    });

    const items: GradeItem[] = [];
    let category: string | null = null;
    let courseTotal: string | null = null;

    for (const row of rows) {
      const name = DECODE(CLEAN(row.itemname));
      if (!name) continue;

      // A row carrying only an item name is a category header, not an item.
      const hasData = "grade" in row || "weight" in row || "percentage" in row;
      if (!hasData) {
        category = name;
        continue;
      }

      const isTotal = /\btotal$/i.test(name);
      const isCourseTotal = /^course total$/i.test(name) || /^강좌 총점$/.test(name);
      const grade = CLEAN(row.grade);
      if (isCourseTotal) courseTotal = grade;

      items.push({
        name,
        category: isCourseTotal ? null : category,
        weight: CLEAN(row.weight),
        grade,
        range: CLEAN(row.range),
        percentage: CLEAN(row.percentage),
        feedback: CLEAN(row.feedback),
        contribution: CLEAN(row.contributiontocoursetotal),
        isTotal,
      });
    }

    return {
      moodleId,
      url,
      items,
      courseTotal,
      gradedCount: items.filter((i) => !i.isTotal && i.grade !== null).length,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/** Scrape the gradebook for every course that has a LearnUS page. */
export async function scrapeGrades(
  context: BrowserContext,
  courseMap: CourseMap
): Promise<Record<string, CourseGrades>> {
  logger.info("Scraping gradebook...");
  const out: Record<string, CourseGrades> = {};

  for (const course of Object.values(courseMap)) {
    if (!course.moodleId || !course.localCode) continue;
    try {
      const report = await scrapeCourseGrades(context, course.moodleId);
      const title = course.title ?? course.fullname;
      // The outermost gradebook category is just the course itself; repeating
      // it on every top-level item is noise.
      const root = new Set([title.toUpperCase(), course.fullname.toUpperCase()]);
      out[course.localCode] = {
        code: course.localCode,
        title,
        ...report,
        items: report.items.map((i) =>
          i.category && root.has(i.category.toUpperCase()) ? { ...i, category: null } : i
        ),
      };
      logger.info(
        `  ${course.localCode}: ${report.items.length} grade items, ${report.gradedCount} graded`
      );
    } catch (e) {
      // One course's gradebook being hidden must not cost us the rest.
      logger.warn(`  ${course.localCode}: gradebook unavailable — ${(e as Error).message}`);
    }
  }

  return out;
}

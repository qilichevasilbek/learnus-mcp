import type { BrowserContext } from "playwright";
import * as config from "../config.js";
import { logger } from "../logger.js";
import { learnusCourses, type CourseMap } from "./courses.js";

export type AssignmentModname = "assign" | "quiz" | "turnitintooltwo";

export interface Assignment {
  name: string;
  url: string;
  modname: AssignmentModname;
  section: string;
  dueDate: string | null;
  status: string | null;
}

/**
 * Every activity type that is a thing the student has to hand in.
 *
 * `turnitintooltwo` belongs here and was missing until 2026-09-22: on a live
 * census of the eight enrolled courses it hid nine assignments, including all
 * four In-Class Essays in UIC1581 (40% of the grade) and every paper in
 * UIC1101 — a course for which this scraper returned an empty list entirely.
 * `learnus_calendar` saw them, so the two tools quietly disagreed.
 */
export const ACTIVITY_LINK_SELECTOR =
  'a[href*="mod/assign/view.php"], a[href*="mod/quiz/view.php"], a[href*="mod/turnitintooltwo/view.php"]';

/** Raw anchor data — exactly what `page.evaluate` is allowed to know. */
export interface RawActivityLink {
  href: string;
  text: string;
  section: string;
}

export interface TurnitinPart {
  title: string;
  start: string | null;
  due: string | null;
  post: string | null;
  marks: string | null;
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * A module's identity is `?id=<cmid>`; `forceview=1`, `#anchor` and friends are
 * noise that would otherwise make one activity look like several.
 */
export function canonicalModuleUrl(href: string): string {
  try {
    const url = new URL(href);
    const id = url.searchParams.get("id");
    url.hash = "";
    url.search = id ? `?id=${id}` : "";
    return url.toString();
  } catch {
    return href;
  }
}

export function classifyModname(href: string): AssignmentModname | null {
  if (href.includes("mod/turnitintooltwo/")) return "turnitintooltwo";
  if (href.includes("mod/quiz/")) return "quiz";
  if (href.includes("mod/assign/")) return "assign";
  return null;
}

/**
 * Normalise a rendered due date to the naive-Seoul shape `output.ts::toInstant`
 * already understands. Turnitin renders "21 Sep 2026 - 16:50"; the assign path
 * renders "2026-09-26 00:00". Only Turnitin dates are routed through this —
 * rewiring the assign/quiz strings would rewrite every existing row of
 * upcoming-summary.md mid-semester, which is a separate, separately verifiable
 * change.
 */
export function normalizeDueDate(raw: string | null | undefined): string | null {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;

  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]} ${iso[4]}:${iso[5]}`;

  const dmy = text.match(
    /\b(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})\s*[-,·]?\s*(\d{1,2}):(\d{2})/
  );
  if (dmy) {
    const month = MONTHS[dmy[2].slice(0, 3).toLowerCase()];
    if (!month) return null;
    return `${dmy[3]}-${month}-${dmy[1].padStart(2, "0")} ${dmy[4].padStart(2, "0")}:${dmy[5]}`;
  }
  return null;
}

/**
 * Rows of `table.partDetails` (Title | Start | Due | Post | Marks).
 *
 * Not every `tbody tr` is a part: on the live UIC1581 essays the table carries a
 * second row that is a one-cell prose instructions blob. Iterating rows naively
 * invents a bogus assignment out of the professor's essay prompt, so a row only
 * counts when it has enough cells and at least one parseable date.
 */
export function parseTurnitinParts(rows: string[][]): TurnitinPart[] {
  const parts: TurnitinPart[] = [];
  for (const row of rows) {
    const cells = row.map((cell) => cell.replace(/\s+/g, " ").trim());
    if (cells.length < 3) continue;

    const [title, start, due, post, marks] = cells;
    if (!title) continue;

    const dueNorm = normalizeDueDate(due);
    const startNorm = normalizeDueDate(start);
    if (!dueNorm && !startNorm) continue;

    parts.push({
      title,
      start: startNorm,
      due: dueNorm,
      post: normalizeDueDate(post),
      marks: marks || null,
    });
  }
  return parts;
}

const foldDashes = (value: string) =>
  value.replace(/[‐-―]/g, "-").replace(/\s+/g, " ").trim();

/**
 * "<Activity> - Part N", matching how `learnus_calendar` names the same event.
 * The names have to agree or upcoming-summary.md shows each Turnitin deadline
 * twice — once from the calendar and once from here.
 */
export function turnitinPartName(activityName: string, partTitle: string): string {
  const activity = foldDashes(activityName);
  const part = foldDashes(partTitle);
  if (!part) return activity;
  if (!activity) return part;
  // Turnitin's part title already spells out the activity ("In-Class Essay #1 -
  // Part 1") and is what learnus_calendar names the same event, so it wins.
  // The course-page anchor is not usable here: Moodle's theme appends an
  // activity-type suffix, giving "In-Class Essay #1 Assignment(TurnItIn)".
  // Joining that to the part title produced a doubled name that no longer
  // matched the calendar, so every Turnitin deadline was listed twice.
  if (/^part\s*\d+$/i.test(part)) return `${activity} - ${part}`;
  return part;
}

/** Rows of `table.submissionsDataTable`. Empty reads as "No records to display.". */
export function summarizeTurnitinSubmissions(rows: string[][]): string | null {
  const real = rows.filter((row) => {
    const text = row.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
    if (!text) return false;
    if (/^no records to display\.?$/.test(text)) return false;
    if (/^loading/.test(text)) return false;
    return true;
  });
  return real.length ? `Submitted (${real.length})` : "Not submitted";
}

/** Dedupe and classify raw anchors. Replaces the logic that lived inside evaluate(). */
export function buildAssignments(links: RawActivityLink[]): Assignment[] {
  const byId = new Map<string, Assignment>();

  for (const link of links) {
    const modname = classifyModname(link.href);
    if (!modname) continue;

    const key = canonicalModuleUrl(link.href);
    const name = (link.text ?? "").replace(/\s+/g, " ").trim();
    const section = (link.section ?? "").replace(/\s+/g, " ").trim();

    const existing = byId.get(key);
    // Prefer the richer anchor: a real title over an icon's alt text, and a hit
    // that actually knew its section. The length filter runs after grouping so
    // an empty icon anchor still contributes the section it knew.
    if (existing) {
      if (name.length > existing.name.length) existing.name = name;
      if (!existing.section && section) existing.section = section;
      continue;
    }

    byId.set(key, { name, url: link.href, modname, section, dueDate: null, status: null });
  }

  return [...byId.values()].filter((item) => item.name.length >= 2);
}

/**
 * One Assignment per Turnitin part. Parts genuinely are separate hand-ins with
 * their own due dates and marks, and per-part naming is what lets the
 * upcoming-summary dedupe collapse this row against the calendar's.
 */
export function expandTurnitinActivity(
  base: Assignment,
  parts: TurnitinPart[],
  status: string | null
): Assignment[] {
  if (!parts.length) return [{ ...base, status }];
  return parts.map((part) => ({
    ...base,
    name: turnitinPartName(base.name, part.title),
    dueDate: part.due,
    status,
  }));
}

export async function scrapeAssignments(
  context: BrowserContext,
  courseMap: CourseMap
): Promise<Record<string, Assignment[]>> {
  const assignments: Record<string, Assignment[]> = {};

  for (const course of learnusCourses(courseMap)) {
    logger.info(`Scraping assignments for ${course.localCode}...`);
    const page = await context.newPage();

    try {
      await page.goto(course.viewUrl, {
        waitUntil: "domcontentloaded",
        timeout: config.NAV_TIMEOUT,
      });
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

      const raw: RawActivityLink[] = await page.evaluate((selector) => {
        const out: Array<{ href: string; text: string; section: string }> = [];
        for (const link of document.querySelectorAll(selector)) {
          const anchor = link as HTMLAnchorElement;
          const section = anchor.closest(".section, [data-sectionid]");
          out.push({
            href: anchor.href,
            text: anchor.textContent ?? "",
            section:
              section?.querySelector(".sectionname, .course-section-header")?.textContent ?? "",
          });
        }
        return out;
      }, ACTIVITY_LINK_SELECTOR);

      const items = buildAssignments(raw);
      const expanded: Assignment[] = [];

      for (const item of items) {
        if (!item.url) continue;
        const detailPage = await context.newPage();
        try {
          await detailPage.goto(item.url, {
            waitUntil: "domcontentloaded",
            timeout: config.NAV_TIMEOUT,
          });

          if (item.modname === "turnitintooltwo") {
            // Turnitin's iframe polls forever, so networkidle just burns its
            // whole budget and tells us nothing. Wait for the table instead.
            await detailPage
              .waitForSelector("table.partDetails tbody tr", { timeout: 10000 })
              .catch(() => {});

            const detail = await detailPage.evaluate(() => {
              const readRows = (selector: string): string[][] =>
                [...document.querySelectorAll(`${selector} tbody tr`)].map((row) =>
                  [...row.querySelectorAll("td, th")].map((cell) => cell.textContent ?? "")
                );
              return {
                partRows: readRows("table.partDetails"),
                submissionRows: readRows("table.submissionsDataTable"),
              };
            });

            const parts = parseTurnitinParts(detail.partRows);
            if (!parts.length) {
              // Usually an unaccepted Turnitin agreement sitting in front of the
              // table. We do not click it — accepting terms on the user's behalf
              // is not this scraper's call. The item survives without a date.
              logger.warn(`  No Turnitin part table for ${item.name} (${item.url})`);
            }
            expanded.push(
              ...expandTurnitinActivity(
                item,
                parts,
                summarizeTurnitinSubmissions(detail.submissionRows)
              )
            );
          } else {
            await detailPage.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

            const details = await detailPage.evaluate(() => {
              let dueDate: string | null = null;
              let status: string | null = null;

              const dateEl = document.querySelector('[data-region="activity-dates"] .text-info');
              if (dateEl) dueDate = dateEl.textContent?.trim() ?? null;

              if (!dueDate) {
                const rows = document.querySelectorAll("tr");
                for (const row of rows) {
                  const label = row.querySelector("td:first-child, th");
                  if (label && /due|마감|기한|closes|종료/i.test(label.textContent ?? "")) {
                    const value = row.querySelector("td:last-child, td:nth-child(2)");
                    if (value) {
                      dueDate = value.textContent?.trim() ?? null;
                      break;
                    }
                  }
                }
              }

              if (!dueDate) {
                const quizInfo = document.querySelector(".quizinfo, .box.generalbox.quizinfo");
                if (quizInfo) {
                  const text = quizInfo.textContent ?? "";
                  const match = text.match(/(?:closes?|마감|종료)[:\s]*(.*?)(?:\.|$)/i);
                  if (match) dueDate = match[1].trim();
                }
              }

              if (!dueDate) {
                const infoEl = document.querySelector(
                  ".mod_assign_submission_dates, [data-region='activity-information'], .activity-dates"
                );
                if (infoEl) dueDate = infoEl.textContent?.trim() ?? null;
              }

              const statusEl = document.querySelector(
                ".submissionstatustable .cell.c1, [data-region='submission-status'], .submissionstatus, .submissionstatussubmitted"
              );
              if (statusEl) status = statusEl.textContent?.trim() ?? null;

              return { dueDate, status };
            });

            item.dueDate = details.dueDate;
            item.status = details.status;
            expanded.push(item);
          }
        } catch {
          // A detail page that will not load costs its dates, not the item.
          expanded.push(item);
        } finally {
          await detailPage.close();
        }
      }

      assignments[course.localCode] = expanded;
      const turnitin = expanded.filter((a) => a.modname === "turnitintooltwo").length;
      logger.info(
        `  Found ${expanded.length} assignments/quizzes` +
          (turnitin ? ` (${turnitin} Turnitin part(s))` : "")
      );
    } catch (e) {
      logger.error(
        `  Error scraping assignments for ${course.localCode}: ${(e as Error).message}`
      );
      assignments[course.localCode] = [];
    } finally {
      await page.close();
    }
  }

  return assignments;
}

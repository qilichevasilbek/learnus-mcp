import type { BrowserContext } from "playwright";
import * as config from "../config.js";
import { logger } from "../logger.js";
import { learnusCourses, type CourseMap } from "./courses.js";
import { canonicalModuleUrl } from "./assignments.js";

export type MaterialSource = "module" | "section-summary";

export interface Material {
  name: string;
  type: string;
  section: string;
  url: string;
  files: Array<{ filename: string; filesize: number }>;
  /** Where it was found. Absent in caches written before 2026-09-22. */
  source?: MaterialSource;
  /** True when the target is not on ys.learnus.org (Google Drive/Docs, news sites…). */
  external?: boolean;
}

export const MODULE_SELECTOR = [
  'a[href*="mod/resource/view.php"]',
  'a[href*="mod/folder/view.php"]',
  'a[href*="mod/vod/view.php"]',
  'a[href*="mod/url/view.php"]',
  'a[href*="mod/page/view.php"]',
  'a[href*="mod/ubfile/view.php"]',
  'a[href*="pluginfile.php"]',
].join(", ");

/**
 * Links the instructor wrote into the weekly section text rather than uploading
 * as a module. Nothing that enumerates modules can ever see these.
 *
 * This is the gap that once led an agent to state, with confidence, that a course's
 * readings were not on LearnUS. All five were — Google Drive links inside `<div class="summary">`. A live count on
 * 2026-09-22 found 53 such links in that one course against 3 module items.
 */
export const SUMMARY_LINK_SELECTOR = "li.section .summary a[href]";

export interface RawLink {
  href: string;
  text: string;
  section: string;
  title?: string;
}

export function isLearnusUrl(href: string): boolean {
  try {
    return new URL(href).origin === new URL(config.LEARNUS_BASE).origin;
  } catch {
    return false;
  }
}

export function classifyMaterialType(href: string): string {
  if (href.includes("mod/folder")) return "folder";
  if (href.includes("mod/vod")) return "vod";
  if (href.includes("mod/url")) return "url";
  if (href.includes("mod/page")) return "page";
  if (href.includes("mod/ubfile")) return "file";
  if (href.includes("pluginfile.php")) return "file";
  if (href.includes("mod/resource")) return "resource";
  return isLearnusUrl(href) ? "resource" : "link";
}

const clean = (value: string | undefined) => (value ?? "").replace(/\s+/g, " ").trim();

/** Anchor text, or a readable fallback, so an icon-only link never goes nameless. */
export function summaryLinkName(text: string, href: string, title?: string): string {
  const label = clean(text);
  if (label.length >= 2) return label;

  const attr = clean(title);
  if (attr.length >= 2) return attr;

  try {
    const url = new URL(href);
    const segment = url.pathname.split("/").filter(Boolean).pop();
    return segment ? `${url.hostname}/${segment}` : url.hostname;
  } catch {
    return href;
  }
}

export function buildMaterials(moduleLinks: RawLink[], summaryLinks: RawLink[]): Material[] {
  const out: Material[] = [];
  const moduleKeys = new Set<string>();

  for (const link of moduleLinks) {
    const name = clean(link.text);
    if (name.length < 2) continue;

    const key = canonicalModuleUrl(link.href);
    if (moduleKeys.has(key)) continue;
    moduleKeys.add(key);

    out.push({
      name,
      type: classifyMaterialType(link.href),
      section: clean(link.section),
      // Keep the original href: syllabus.ts's download path needs the real query string.
      url: link.href,
      files: [],
      source: "module",
      external: false,
    });
  }

  const seenSummary = new Set<string>();
  for (const link of summaryLinks) {
    const href = link.href ?? "";
    if (!href || /^(#|javascript:|mailto:)/i.test(href)) continue;

    const key = canonicalModuleUrl(href);
    // The professor also linking a module inline is the same fact twice.
    if (moduleKeys.has(key)) continue;

    const section = clean(link.section);
    // The same Drive reading listed under Week 3 and Week 10 is two facts, and
    // the week is the only thing that makes the row useful — so the section is
    // part of the key.
    const dedupeKey = `${section}|${key}`;
    if (seenSummary.has(dedupeKey)) continue;
    seenSummary.add(dedupeKey);

    out.push({
      name: summaryLinkName(link.text, href, link.title),
      type: classifyMaterialType(href),
      section,
      url: href,
      files: [],
      source: "section-summary",
      external: !isLearnusUrl(href),
    });
  }

  return out;
}

export async function scrapeMaterials(
  context: BrowserContext,
  courseMap: CourseMap
): Promise<Record<string, Material[]>> {
  const materials: Record<string, Material[]> = {};

  for (const course of learnusCourses(courseMap)) {
    logger.info(`Scraping materials for ${course.localCode}...`);
    const page = await context.newPage();

    try {
      await page.goto(course.viewUrl, {
        waitUntil: "domcontentloaded",
        timeout: config.NAV_TIMEOUT,
      });
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

      const raw = await page.evaluate(
        ({ moduleSelector, summarySelector }) => {
          const read = (nodes: NodeListOf<Element>) =>
            [...nodes].map((node) => {
              const anchor = node as HTMLAnchorElement;
              const section = anchor.closest(".section, [data-sectionid]");
              return {
                href: anchor.href,
                text: anchor.textContent ?? "",
                title: anchor.getAttribute("title") ?? "",
                section:
                  section?.querySelector(".sectionname, .course-section-header")?.textContent ??
                  "",
              };
            });

          return {
            modules: read(document.querySelectorAll(moduleSelector)),
            summary: read(document.querySelectorAll(summarySelector)),
          };
        },
        { moduleSelector: MODULE_SELECTOR, summarySelector: SUMMARY_LINK_SELECTOR }
      );

      const items = buildMaterials(raw.modules, raw.summary);
      materials[course.localCode] = items;

      const fromSummary = items.filter((m) => m.source === "section-summary").length;
      logger.info(
        `  Found ${items.length} material items` +
          (fromSummary ? ` (${fromSummary} from section descriptions)` : "")
      );
    } catch (e) {
      logger.error(
        `  Error scraping materials for ${course.localCode}: ${(e as Error).message}`
      );
      materials[course.localCode] = [];
    } finally {
      await page.close();
    }
  }

  return materials;
}

import type { BrowserContext } from "playwright";
import * as config from "../config.js";
import { logger } from "../logger.js";
import { learnusCourses, type CourseMap } from "./courses.js";

export interface Announcement {
  title: string;
  url: string;
  date: string;
  author: string;
}

export async function scrapeAnnouncements(
  context: BrowserContext,
  courseMap: CourseMap
): Promise<Record<string, Announcement[]>> {
  const announcements: Record<string, Announcement[]> = {};

  for (const course of learnusCourses(courseMap)) {
    logger.info(`Scraping announcements for ${course.localCode}...`);
    const page = await context.newPage();

    try {
      await page.goto(course.viewUrl, {
        waitUntil: "domcontentloaded",
        timeout: config.NAV_TIMEOUT,
      });
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

      // Find announcement board links
      const boardLinks = await page.$$eval(
        'a[href*="mod/ubboard/view.php"], a[href*="mod/forum/view.php"]',
        (els) =>
          els.map((el) => ({
            href: (el as HTMLAnchorElement).href,
            text: el.textContent?.trim() ?? "",
          }))
      );

      let targetLink = boardLinks.find((l) =>
        /announcement|공지|notice|news/i.test(l.text)
      );

      if (!targetLink) {
        targetLink = boardLinks.find(
          (l) =>
            !l.href.includes("id=2009295") &&
            !l.href.includes("id=2323883") &&
            !l.href.includes("id=2323884") &&
            l.text.length > 0
        );
      }

      if (!targetLink) {
        // Try inline articles
        const inlineArticles: Announcement[] = await page.$$eval(
          'a[href*="mod/ubboard/article.php"]',
          (els) =>
            els
              .map((el) => {
                const text = el.textContent?.trim() ?? "";
                const dateMatch = text.match(
                  /(\d{2}\/\d{2}\/\d{2},?\s*\d{2}:\d{2})/
                );
                const titlePart = dateMatch
                  ? text.substring(0, text.indexOf(dateMatch[0])).trim()
                  : text;
                return {
                  title: titlePart,
                  url: (el as HTMLAnchorElement).href,
                  date: dateMatch ? dateMatch[1] : "",
                  author: "",
                };
              })
              .filter((a) => a.title.length > 2)
        );

        if (inlineArticles.length > 0) {
          announcements[course.localCode] = inlineArticles;
          logger.info(`  Found ${inlineArticles.length} inline announcements`);
          await page.close();
          continue;
        }

        logger.warn(`  No announcements board found for ${course.localCode}`);
        announcements[course.localCode] = [];
        await page.close();
        continue;
      }

      // Navigate to the board
      await page.goto(targetLink.href, {
        waitUntil: "domcontentloaded",
        timeout: config.NAV_TIMEOUT,
      });
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

      const posts: Announcement[] = await page.evaluate(() => {
        const results: Array<{
          title: string;
          url: string;
          author: string;
          date: string;
        }> = [];

        const rows = document.querySelectorAll("table tbody tr");
        for (const row of rows) {
          const cells = row.querySelectorAll("td");
          const titleEl = row.querySelector(
            'a[href*="article.php"], a[href*="discuss.php"]'
          ) as HTMLAnchorElement | null;

          if (titleEl && cells.length >= 4) {
            results.push({
              title: titleEl.textContent?.trim() ?? "",
              url: titleEl.href || "",
              author: cells[2]?.textContent?.trim() ?? "",
              date: cells[3]?.textContent?.trim() ?? "",
            });
          }
        }

        if (results.length === 0) {
          const items = document.querySelectorAll(
            '.ubboard-article, .board-article, .article-item, [class*="article"]'
          );
          for (const item of items) {
            const tEl = item.querySelector("a") as HTMLAnchorElement | null;
            const dateEl = item.querySelector('.date, time, [class*="date"]');
            const authorEl = item.querySelector('.author, [class*="author"]');

            if (tEl && (tEl.textContent?.trim().length ?? 0) > 2) {
              results.push({
                title: tEl.textContent?.trim() ?? "",
                url: tEl.href || "",
                date: dateEl?.textContent?.trim() ?? "",
                author: authorEl?.textContent?.trim() ?? "",
              });
            }
          }
        }

        if (results.length === 0) {
          const links = document.querySelectorAll(
            'a[href*="article.php"], a[href*="discuss.php"]'
          );
          for (const link of links) {
            const text = link.textContent?.trim() ?? "";
            if (text.length > 2) {
              results.push({
                title: text,
                url: (link as HTMLAnchorElement).href,
                date: "",
                author: "",
              });
            }
          }
        }

        return results;
      });

      announcements[course.localCode] = posts;
      logger.info(`  Found ${posts.length} announcements`);
    } catch (e) {
      logger.error(
        `  Error scraping announcements for ${course.localCode}: ${(e as Error).message}`
      );
      announcements[course.localCode] = [];
    } finally {
      await page.close();
    }
  }

  return announcements;
}

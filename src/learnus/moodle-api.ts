import type { BrowserContext, Page } from "playwright";
import * as config from "./config.js";
import { logger } from "./logger.js";

export class MoodleAPI {
  private context: BrowserContext;
  private sesskey: string;
  private baseUrl: string;
  private _page: Page | null = null;

  constructor(context: BrowserContext, sesskey: string) {
    this.context = context;
    this.sesskey = sesskey;
    this.baseUrl = config.LEARNUS_BASE;
  }

  async callAjax(functionName: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this._page || this._page.isClosed()) {
      this._page = await this.context.newPage();
      await this._page.goto(this.baseUrl + "/my/", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
    }
    const page = this._page;

    const url = `${this.baseUrl}/lib/ajax/service.php?sesskey=${this.sesskey}&info=${functionName}`;
    const payload = [{ index: 0, methodname: functionName, args }];

    const response = await page.evaluate(
      async ({ url, payload }: { url: string; payload: unknown }) => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        return res.json();
      },
      { url, payload }
    ) as unknown;

    logger.info(
      `API response for ${functionName}: ${JSON.stringify(response).substring(0, 500)}`
    );

    // Handle top-level error
    if (
      response &&
      typeof response === "object" &&
      "error" in response &&
      !Array.isArray(response)
    ) {
      const r = response as { error: string; errorcode?: string };
      throw new Error(`Moodle API error (${functionName}): ${r.errorcode} - ${r.error}`);
    }

    if (Array.isArray(response)) {
      if (response[0]?.error) {
        throw new Error(
          `Moodle API error (${functionName}): ${JSON.stringify(response[0].exception || response[0])}`
        );
      }
      return response[0]?.data || response[0];
    }

    return response;
  }

  async close(): Promise<void> {
    if (this._page && !this._page.isClosed()) {
      await this._page.close();
    }
  }

  async getEnrolledCourses(): Promise<unknown> {
    return this.callAjax(
      "core_course_get_enrolled_courses_by_timeline_classification",
      { offset: 0, limit: 0, classification: "inprogress", sort: "fullname" }
    );
  }

  /**
   * The month grid behind https://ys.learnus.org/calendar/view.php?view=month.
   *
   * This is the richest view LearnUS exposes. `getCalendarEvents` below only
   * returns *action* events — items with an outstanding student action — which
   * on a typical week is two or three rows. The month view returns every event
   * the calendar knows about: open/close windows, `expectcompletionon` targets,
   * Zoom class sessions, VOD availability windows and Turnitin deadlines, for
   * every enrolled course including ones with no assignment activity at all.
   *
   * `month` is 1-12. `courseId` 1 is the site course, i.e. "all courses".
   */
  async getMonthlyCalendar(
    year: number,
    month: number,
    courseId = 1
  ): Promise<unknown> {
    return this.callAjax("core_calendar_get_calendar_monthly_view", {
      year,
      month,
      courseid: courseId,
      categoryid: 0,
      includenavigation: false,
      mini: false,
    });
  }

  /** The "예정된 할일" upcoming panel — events ahead of now, any type. */
  async getUpcomingCalendar(courseId = 1): Promise<unknown> {
    return this.callAjax("core_calendar_get_calendar_upcoming_view", {
      courseid: courseId,
      categoryid: 0,
    });
  }

  async getCalendarEvents(courseId?: number): Promise<unknown> {
    const now = Math.floor(Date.now() / 1000);
    const args: Record<string, unknown> = {
      timesortfrom: now,
      timesortto: now + 30 * 24 * 60 * 60,
      limitnum: 50,
    };
    if (courseId) {
      return this.callAjax("core_calendar_get_action_events_by_course", {
        ...args,
        courseid: courseId,
      });
    }
    return this.callAjax("core_calendar_get_action_events_by_timesort", args);
  }
}

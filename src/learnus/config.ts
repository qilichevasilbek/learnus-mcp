import os from "node:os";
import path from "node:path";

export const LEARNUS_BASE = "https://ys.learnus.org";

/**
 * Yonsei 전자출결 (Electronic Attendance) system. This — not LearnUS — is the
 * authoritative source for the official timetable (room, period, professor,
 * delivery format) and for recorded attendance. LearnUS's own
 * `/local/ubattendance/` pages exist but Yonsei never populates them.
 */
export const ROLLBOOK_BASE = "https://ysrollbook.yonsei.ac.kr";

export const STUDENT_ID = process.env.YONSEI_ID ?? "";
export const STUDENT_PW = process.env.YONSEI_PW ?? "";

/**
 * Everything this server writes (session cookies, the sync cache, logs,
 * downloaded attachments) lives under one directory. Override with
 * LEARNUS_MCP_HOME; the default keeps it out of any project checkout.
 */
export const HOME_DIR = process.env.LEARNUS_MCP_HOME || path.join(os.homedir(), ".learnus-mcp");

/** Per-course Markdown (`<CODE>/*.md`) the sync writes for humans and agents to read. */
export const COURSES_DIR = path.join(HOME_DIR, "courses");

/** Normalized JSON cache the MCP tools read from instead of scraping live. */
export const CACHE_DIR = path.join(COURSES_DIR, "data");

export const DATA_DIR = path.join(HOME_DIR, "state");
export const LOGS_DIR = path.join(HOME_DIR, "logs");
/** Attachments fetched by learnus_fetch_url that are saved rather than returned as text. */
export const DOWNLOAD_DIR = path.join(HOME_DIR, "downloads");

export const SESSION_FILE = path.join(DATA_DIR, "learnus-session.json");
export const COURSE_MAP_FILE = path.join(DATA_DIR, "course-map.json");
export const LAST_RUN_FILE = path.join(DATA_DIR, "last-run.json");
export const SYNC_LOCK_FILE = path.join(DATA_DIR, "sync.lock");

export const NAV_TIMEOUT = 30_000;
export const LOGIN_TIMEOUT = 60_000;
export const HEADLESS = true;
export const SLOW_MO = 100;

/**
 * Current Yonsei semester code, `<year><term>` (term 1 = spring, 2 = fall).
 * Derived from the clock so it does not need editing every term; override with
 * YONSEI_SEMESTER if the academic calendar ever disagrees with the month.
 */
export function currentSemester(now = new Date()): string {
  const override = process.env.YONSEI_SEMESTER;
  if (override && /^\d{5}$/.test(override)) return override;
  const seoul = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const month = seoul.getMonth() + 1;
  // Spring runs Mar–Aug, Fall runs Sep–Feb (Jan/Feb belong to the prior fall).
  if (month <= 2) return `${seoul.getFullYear() - 1}2`;
  return `${seoul.getFullYear()}${month <= 8 ? 1 : 2}`;
}

/** How long cached sync output is considered fresh before tools warn about it. */
export const CACHE_STALE_MS = 6 * 60 * 60 * 1000; // 6 hours

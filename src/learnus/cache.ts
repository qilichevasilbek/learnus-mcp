/**
 * Normalized on-disk cache for LMS/portal data.
 *
 * Every tool call used to launch a headless Chromium, log in through SSO and
 * re-scrape the DOM — 30-60s and a large token bill for a question as small as
 * "when is my next deadline". The background sync writes normalized JSON here
 * and the tools read it in about a millisecond, falling back to a live scrape
 * only when explicitly asked or when nothing has ever been cached.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as config from "./config.js";

export type CacheKey =
  | "assignments"
  | "announcements"
  | "materials"
  | "calendar"
  | "timetable"
  | "attendance"
  | "grades"
  | "courses";

export interface CacheEnvelope<T> {
  fetchedAt: string;
  semester: string;
  data: T;
}

export interface CacheRead<T> {
  data: T;
  fetchedAt: Date;
  ageMs: number;
  stale: boolean;
}

function cacheFile(key: CacheKey): string {
  return path.join(config.CACHE_DIR, `${key}.json`);
}

export function writeCache<T>(key: CacheKey, data: T, semester = config.currentSemester()): void {
  fs.mkdirSync(config.CACHE_DIR, { recursive: true });
  const envelope: CacheEnvelope<T> = {
    fetchedAt: new Date().toISOString(),
    semester,
    data,
  };
  // Write-then-rename so a reader never observes a half-written file.
  const tmp = `${cacheFile(key)}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2));
  fs.renameSync(tmp, cacheFile(key));
}

export function readCache<T>(key: CacheKey): CacheRead<T> | null {
  const file = cacheFile(key);
  if (!fs.existsSync(file)) return null;
  try {
    const envelope = JSON.parse(fs.readFileSync(file, "utf-8")) as CacheEnvelope<T>;
    const fetchedAt = new Date(envelope.fetchedAt);
    const ageMs = Date.now() - fetchedAt.getTime();
    return {
      data: envelope.data,
      fetchedAt,
      ageMs,
      stale: ageMs > config.CACHE_STALE_MS,
    };
  } catch {
    return null;
  }
}

/** "3 minutes ago" — used to tell the model how much to trust what it just read. */
export function describeAge(ageMs: number): string {
  const min = Math.round(ageMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export interface SyncState {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: "success" | "partial" | "failed";
  semester: string;
  courseCount: number;
  steps: Record<string, { ok: boolean; error?: string; count?: number }>;
  error?: string;
}

export function writeSyncState(state: SyncState): void {
  fs.mkdirSync(config.CACHE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(config.CACHE_DIR, "sync-state.json"),
    JSON.stringify(state, null, 2)
  );
}

export function readSyncState(): SyncState | null {
  const file = path.join(config.CACHE_DIR, "sync-state.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as SyncState;
  } catch {
    return null;
  }
}

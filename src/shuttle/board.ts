/**
 * Finds and fetches the shuttle timetable notices on yonsei.ac.kr (board 58).
 *
 * Plain `fetch`: these pages are public, so nothing here needs a login, a
 * browser or credentials. Parsed results are cached on disk and a stale cache
 * is used, labelled, when the site cannot be reached.
 */
import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import { CACHE_DIR } from "../learnus/config.js";
import { parseNotice, ShuttleParseError, type ShuttleTimetable } from "./parse.js";

const BASE = "https://www.yonsei.ac.kr";
const LIST_URL = `${BASE}/bbs/sc/58/artclList.do`;
const USER_AGENT = "learnus-mcp (+https://github.com/qilichevasilbek/learnus-mcp)";
const TITLE = /국제캠퍼스\s*셔틀버스\s*운행\s*시간표/;

const LIST_TTL_MS = 6 * 60 * 60 * 1000;
const NOTICE_TTL_MS = 12 * 60 * 60 * 1000;

export interface NoticeRef {
  id: string;
  title: string;
  url: string;
  postedDate: string | null;
}

export interface Fetched<T> {
  value: T;
  /** Set when the live fetch failed and an older cached copy was used. */
  staleSince?: string;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return res.text();
}

/* ------------------------------------------------------------------ cache --- */

const dir = () => path.join(CACHE_DIR, "shuttle");

function readCache<T>(name: string): { at: number; value: T } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir(), name), "utf8"));
  } catch {
    return null;
  }
}

function writeCache(name: string, value: unknown): void {
  try {
    fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir(), name), JSON.stringify({ at: Date.now(), value }));
  } catch {
    /* a cache that cannot be written is only a slower next call */
  }
}

async function cached<T>(name: string, ttl: number, refresh: boolean, load: () => Promise<T>): Promise<Fetched<T>> {
  const hit = readCache<T>(name);
  if (hit && !refresh && Date.now() - hit.at < ttl) return { value: hit.value };
  try {
    const value = await load();
    writeCache(name, value);
    return { value };
  } catch (err) {
    // A parse error means the page changed shape: surface it, don't hide it behind old data.
    if (hit && !(err instanceof ShuttleParseError)) {
      return { value: hit.value, staleSince: new Date(hit.at).toISOString() };
    }
    throw err;
  }
}

/* ------------------------------------------------------------------- list --- */

export function parseList(html: string): NoticeRef[] {
  const $ = cheerio.load(html);
  const out: NoticeRef[] = [];
  $('a[href*="artclView.do"]').each((_, a) => {
    const href = $(a).attr("href") ?? "";
    const id = href.match(/\/(\d+)\/artclView\.do/)?.[1];
    const title = $(a).find(".title strong").text().replace(/^\s*[<＜]\s*|\s*[>＞]\s*$/g, "").replace(/\s+/g, " ").trim();
    if (!id || !TITLE.test(title)) return;
    const posted = $(a).find(".date-area").text().match(/(\d{4})\.(\d{2})\.(\d{2})/);
    out.push({
      id,
      title,
      url: `${BASE}/bbs/sc/58/${id}/artclView.do`,
      postedDate: posted ? `${posted[1]}-${posted[2]}-${posted[3]}` : null,
    });
  });
  return out;
}

export function listTimetableNotices(refresh = false): Promise<Fetched<NoticeRef[]>> {
  return cached("list.json", LIST_TTL_MS, refresh, async () => {
    const q = new URLSearchParams({ findType: "sj", findWord: "국제캠퍼스 셔틀버스 운행 시간표" });
    const refs = parseList(await fetchText(`${LIST_URL}?${q}`));
    if (!refs.length) {
      throw new ShuttleParseError(`${LIST_URL}: no shuttle timetable notices were found on the board.`);
    }
    return refs;
  });
}

export function loadTimetable(ref: NoticeRef, refresh = false): Promise<Fetched<ShuttleTimetable>> {
  return cached(`notice-${ref.id}.json`, NOTICE_TTL_MS, refresh, async () =>
    parseNotice(await fetchText(ref.url), ref)
  );
}

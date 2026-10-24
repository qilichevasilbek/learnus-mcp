import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { APIResponse, BrowserContext } from "playwright";
import * as config from "./config.js";
import { logger } from "./logger.js";
import { extractBuffer } from "./extract.js";
import { extractPage } from "../extract/extract.js";

export interface AnnouncementDetail {
  content: string;
  attachments: Array<{ name: string; url: string }>;
}

export async function fetchSingleAnnouncement(
  context: BrowserContext,
  url: string
): Promise<AnnouncementDetail> {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

    const content = await page.evaluate(() => {
      const body = document.querySelector(
        ".ubboard-article-body, .article-body, .board-article-body, .content-body, .text_to_html, .ubboard_article_body"
      );
      if (body) return body.textContent?.trim() ?? "";

      const main = document.querySelector("#region-main .content, #region-main");
      if (main) {
        const clone = main.cloneNode(true) as HTMLElement;
        clone
          .querySelectorAll(
            "nav, .breadcrumb, .activity-navigation, script, style, .ubboard-list, table.ubboard-article-list"
          )
          .forEach((el) => el.remove());
        return clone.textContent?.trim() ?? "";
      }

      return (document.body.textContent?.trim() ?? "").substring(0, 3000);
    });

    const attachments = await page.evaluate(() => {
      const files: Array<{ name: string; url: string }> = [];
      document
        .querySelectorAll('a[href*="pluginfile.php"], a[href*="file.php"]')
        .forEach((l) => {
          const name = l.textContent?.trim() ?? "";
          if (name.length > 1) {
            files.push({ name, url: (l as HTMLAnchorElement).href });
          }
        });
      return files;
    });

    return { content, attachments };
  } finally {
    await page.close();
  }
}

/* ------------------------------------------------- arbitrary URL fetching --- */

/**
 * Hosts this tool will authenticate against.
 *
 * `ysrollbook` is included because it rides the same Yonsei SSO cookie — see
 * `rollbook.ts`, which navigates there and lets the cookie log it in.
 */
export const ALLOWED_HOSTS = new Set([
  "ys.learnus.org",
  "www.learnus.org",
  "learnus.org",
  "ysrollbook.yonsei.ac.kr",
  "infra.yonsei.ac.kr",
]);

// A downloaded attachment is reported by filesystem path.
const DOWNLOAD_DIR = config.DOWNLOAD_DIR;

/** Refuse anything larger rather than pulling a lecture video into memory. */
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

export class LearnusSessionExpired extends Error {
  constructor(url: string) {
    super(
      `LearnUS returned its login page for ${url}, which means the cached session is no longer valid. ` +
        `Run any learnus_* tool with refresh:true to force a fresh SSO login, then retry this fetch.`
    );
    this.name = "LearnusSessionExpired";
  }
}

export function assertAllowedHost(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Only http(s) URLs are supported, got ${url.protocol}`);
  }
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error(
      `${url.hostname} is not a Yonsei host. learnus_fetch_url only authenticates against: ` +
        `${[...ALLOWED_HOSTS].join(", ")}. For any other site use web_surf or the browser tools.`
    );
  }
  return url;
}

/**
 * The failure that matters, because it does not look like a failure.
 *
 * Measured 2026-09-22: fetching a real course file without a session returns
 * HTTP **200** with `text/html` — the login page wearing a success code. Code
 * that checks only the status silently substitutes a login form for the
 * document, which is exactly how an agent concludes that content "does not
 * exist". Every path through this module runs this check.
 */
export function looksLikeLoginWall(finalUrl: string, body: string): boolean {
  if (/\/login\.php|\/passni\/sso\/spLogin/i.test(finalUrl)) return true;
  const head = body.slice(0, 4000);
  return (
    /id=["']loginId["']/i.test(head) ||
    /id=["']loginPasswd["']/i.test(head) ||
    /btn-sso/i.test(head) ||
    /fSubmitSSOLoginForm/i.test(head)
  );
}

/** `attachment; filename="x.docx"` / RFC 5987 `filename*=UTF-8''x.docx`. */
export function filenameFromDisposition(header: string | undefined): string | null {
  if (!header) return null;
  const star = header.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^["']|["']$/g, ""));
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = header.match(/filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i);
  const value = plain?.[1] ?? plain?.[2];
  return value ? value.trim() : null;
}

function safeLocalName(name: string): string {
  const ext = path.extname(name).toLowerCase().slice(0, 12) || ".bin";
  return `${randomBytes(8).toString("hex")}${ext.replace(/[^a-z0-9.]/g, "")}`;
}

export interface FetchUrlOptions {
  /** Cap on returned text. */
  maxChars?: number;
  /** Persist a downloaded attachment under the uploads tree. Default true. */
  save?: boolean;
}

export interface FetchedUrl {
  requestedUrl: string;
  finalUrl: string;
  kind: "page" | "file";
  contentType: string;
  /** Page title, or the attachment's filename. */
  title: string;
  /** Clean Markdown for a page; extracted text for a file. */
  text: string;
  truncated: boolean;
  attachments: Array<{ name: string; url: string }>;
  /** Markdown renderings of any tables on the page (Turnitin part tables land here). */
  tables: string[];
  /** Filesystem path of a saved attachment. */
  savedTo?: string;
  bytes?: number;
  /** Set when a file's bytes could not be turned into text. */
  extractionError?: string;
}

function headerValue(res: APIResponse, name: string): string | undefined {
  return res.headers()[name];
}

/**
 * Authenticated GET of any Yonsei LMS URL — a page or an attachment.
 *
 * Deliberately classifies with a cheap request first: `mod/ubfile/view.php`
 * streams its file directly, and `page.goto` on it throws "Download is
 * starting", so binaries must go through the request API while HTML pages need
 * a real page to run their JavaScript (Turnitin renders its tables client-side).
 */
export async function fetchUrl(
  context: BrowserContext,
  rawUrl: string,
  options: FetchUrlOptions = {}
): Promise<FetchedUrl> {
  const { maxChars = 20000, save = true } = options;
  const url = assertAllowedHost(rawUrl);

  const res = await context.request.get(url.toString(), {
    maxRedirects: 5,
    timeout: config.NAV_TIMEOUT,
  });
  const finalUrl = res.url();
  const contentType = headerValue(res, "content-type") ?? "";
  const disposition = headerValue(res, "content-disposition");
  const isHtml = /text\/html|application\/xhtml/i.test(contentType);

  if (isHtml && !disposition) {
    const probe = await res.text();
    if (looksLikeLoginWall(finalUrl, probe)) throw new LearnusSessionExpired(rawUrl);
    return fetchRenderedPage(context, url.toString(), maxChars);
  }

  // Anything else is a file. A login wall here would have arrived as HTML.
  if (looksLikeLoginWall(finalUrl, "")) throw new LearnusSessionExpired(rawUrl);

  const declared = Number(headerValue(res, "content-length") ?? "0");
  if (declared > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `${rawUrl} is ${(declared / 1024 / 1024).toFixed(1)} MB, over the ${
        MAX_DOWNLOAD_BYTES / 1024 / 1024
      } MB limit. Download it outside the tool if you really need it.`
    );
  }

  const buf = await res.body();
  if (buf.length > MAX_DOWNLOAD_BYTES) {
    throw new Error(`${rawUrl} exceeded the ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB limit.`);
  }

  // A stale session can also return HTML bytes under a generic content type.
  if (looksLikeLoginWall(finalUrl, buf.subarray(0, 4000).toString("utf8"))) {
    throw new LearnusSessionExpired(rawUrl);
  }

  const filename =
    filenameFromDisposition(disposition) ||
    decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "download.bin");
  const ext = path.extname(filename).toLowerCase() || ".bin";

  const extracted = await extractBuffer(buf, ext);
  let text = extracted.ok ? extracted.text : "";
  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars);

  const result: FetchedUrl = {
    requestedUrl: rawUrl,
    finalUrl,
    kind: "file",
    contentType,
    title: filename,
    text,
    truncated,
    attachments: [],
    tables: [],
    bytes: buf.length,
  };
  if (!extracted.ok) result.extractionError = extracted.error;

  if (save) {
    try {
      fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
      const local = safeLocalName(filename);
      const target = path.join(DOWNLOAD_DIR, local);
      fs.writeFileSync(target, buf);
      result.savedTo = target;
    } catch (e) {
      logger.warn(`Could not save ${filename}: ${(e as Error).message}`);
    }
  }

  return result;
}

async function fetchRenderedPage(
  context: BrowserContext,
  url: string,
  maxChars: number
): Promise<FetchedUrl> {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.NAV_TIMEOUT });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

    const finalUrl = page.url();
    const html = await page.content();
    if (looksLikeLoginWall(finalUrl, html)) throw new LearnusSessionExpired(url);

    const attachments = await page.evaluate(() => {
      const files: Array<{ name: string; url: string }> = [];
      const seen = new Set<string>();
      document
        .querySelectorAll(
          'a[href*="pluginfile.php"], a[href*="file.php"], a[href*="mod/ubfile/view.php"]'
        )
        .forEach((el) => {
          const anchor = el as HTMLAnchorElement;
          if (seen.has(anchor.href)) return;
          seen.add(anchor.href);
          files.push({ name: anchor.textContent?.trim() || anchor.href, url: anchor.href });
        });
      return files;
    });

    const extracted = await extractPage(html, finalUrl, { maxChars });

    return {
      requestedUrl: url,
      finalUrl,
      kind: "page",
      contentType: "text/html",
      title: extracted.metadata.title || (await page.title()),
      text: extracted.markdown,
      truncated: extracted.truncated,
      attachments,
      tables: extracted.tables.map((t) => t.markdown),
    };
  } finally {
    await page.close();
  }
}

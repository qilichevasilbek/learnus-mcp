/**
 * Finds, downloads and transcribes syllabus / course-schedule documents.
 *
 * A syllabus is the one document that states what the course actually requires,
 * yet it normally sits behind a LearnUS resource link as a PDF or HWP nobody
 * ever reads programmatically. This walks the scraped materials, pulls anything
 * that looks like a syllabus or schedule through the authenticated session, and
 * writes plain text to courses/<CODE>/syllabus.md.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { BrowserContext } from "playwright";
import * as config from "./config.js";
import { logger } from "./logger.js";
import { extractText, EXTRACTABLE } from "./extract.js";
import { isLearnusUrl, type Material } from "./scrapers/materials.js";

const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

async function responseBodyWithinLimit(
  res: import("playwright").APIResponse
): Promise<Buffer | null> {
  const declared = Number(res.headers()["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_DOCUMENT_BYTES) return null;
  const body = await res.body();
  return body.length <= MAX_DOCUMENT_BYTES ? body : null;
}

/** Name patterns, in priority order, that mark a document as course-defining. */
const SYLLABUS_PATTERNS: Array<{ re: RegExp; weight: number }> = [
  { re: /syllabus|강의계획|강의계획서/i, weight: 100 },
  { re: /course\s*schedule|수업일정|강의일정|course\s*outline/i, weight: 80 },
  { re: /schedule|일정표/i, weight: 50 },
  { re: /grading|평가|policy|정책/i, weight: 30 },
  { re: /course\s*info|orientation|오리엔테이션/i, weight: 20 },
];

export interface SyllabusDoc {
  course: string;
  materialName: string;
  filename: string;
  url: string;
  score: number;
  savedTo: string | null;
  chars: number;
  ok: boolean;
  error?: string;
}

function scoreName(name: string): number {
  let score = 0;
  for (const { re, weight } of SYLLABUS_PATTERNS) {
    if (re.test(name)) score = Math.max(score, weight);
  }
  return score;
}

function candidatesFor(materials: Material[]): Array<{ material: Material; score: number }> {
  const out: Array<{ material: Material; score: number }> = [];
  for (const material of materials) {
    // Only a LearnUS-hosted file can be fetched with the LearnUS session. Once
    // section-summary links joined this list (2026-09-22) an off-site Drive or
    // Docs link named "...schedule..." could outscore the real syllabus PDF and
    // take one of the three slots below — then fail to download, returning a
    // login page that is not a document. UIC1581 alone contributes 53 such
    // links, so this guard is what keeps syllabus.md working.
    if (!isLearnusUrl(material.url)) continue;
    const names = [material.name, ...(material.files ?? []).map((f) => f.filename)];
    const score = Math.max(...names.map(scoreName), 0);
    if (score >= 20) out.push({ material, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

function filenameFromDisposition(header: string | undefined, fallback: string): string {
  if (!header) return fallback;
  const star = header.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].replace(/"/g, "").trim());
    } catch {
      /* fall through */
    }
  }
  const plain = header.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1].trim() : fallback;
}

/**
 * Fetch a LearnUS resource. `/mod/resource/view.php?id=N` normally 302s to the
 * real file; Playwright's request context follows that and keeps our cookies.
 */
async function download(
  context: BrowserContext,
  url: string
): Promise<{ buffer: Buffer; filename: string } | null> {
  try {
    const res = await context.request.get(url, { timeout: config.NAV_TIMEOUT, maxRedirects: 5 });
    if (!res.ok()) return null;
    const headers = res.headers();
    const fallback = decodeURIComponent(new URL(res.url()).pathname.split("/").pop() || "file");
    const filename = filenameFromDisposition(headers["content-disposition"], fallback);
    const body = await responseBodyWithinLimit(res);
    if (!body) return null;
    // An HTML body means we got a Moodle interstitial, not the file itself.
    if ((headers["content-type"] ?? "").includes("text/html")) {
      const html = body.toString("utf8");
      const forced = html.match(/window\.location\s*=\s*["']([^"']+)["']/)?.[1]
        ?? html.match(/<a[^>]+href="([^"]+\/pluginfile\.php\/[^"]+)"/)?.[1];
      if (forced) {
        const nested = await context.request.get(forced.replace(/&amp;/g, "&"), {
          timeout: config.NAV_TIMEOUT,
          maxRedirects: 5,
        });
        if (nested.ok()) {
          const nestedBody = await responseBodyWithinLimit(nested);
          if (!nestedBody) return null;
          return {
            buffer: nestedBody,
            filename: filenameFromDisposition(
              nested.headers()["content-disposition"],
              decodeURIComponent(new URL(nested.url()).pathname.split("/").pop() || "file")
            ),
          };
        }
      }
      return null;
    }
    return { buffer: body, filename };
  } catch {
    return null;
  }
}

/**
 * Download and transcribe the best syllabus candidate for each course.
 * Returns one entry per document actually processed.
 */
export async function collectSyllabuses(
  context: BrowserContext,
  materialsByCourse: Record<string, Material[]>,
  opts: { maxPerCourse?: number } = {}
): Promise<SyllabusDoc[]> {
  const { maxPerCourse = 3 } = opts;
  const results: SyllabusDoc[] = [];

  for (const [code, materials] of Object.entries(materialsByCourse)) {
    const candidates = candidatesFor(materials ?? []).slice(0, maxPerCourse);
    if (!candidates.length) continue;

    const courseDir = path.join(config.COURSES_DIR, code);
    const rawDir = path.join(courseDir, "syllabus-files");
    const sections: string[] = [];
    // Instructors routinely post the same syllabus twice (say, in Week 0 and
    // again under "Course Info"). Those are distinct resource ids with distinct
    // names, so only the bytes tell us it is one document.
    const seen = new Set<string>();

    for (const { material, score } of candidates) {
      const got = await download(context, material.url);
      if (!got) {
        results.push({
          course: code,
          materialName: material.name,
          filename: "",
          url: material.url,
          score,
          savedTo: null,
          chars: 0,
          ok: false,
          error: "download failed",
        });
        continue;
      }

      const ext = path.extname(got.filename).toLowerCase();
      if (!EXTRACTABLE.has(ext)) {
        results.push({
          course: code,
          materialName: material.name,
          filename: got.filename,
          url: material.url,
          score,
          savedTo: null,
          chars: 0,
          ok: false,
          error: `not a document (${ext || "no extension"})`,
        });
        continue;
      }

      const digest = crypto.createHash("sha1").update(got.buffer).digest("hex");
      if (seen.has(digest)) continue;
      seen.add(digest);

      fs.mkdirSync(rawDir, { recursive: true });
      const safe = got.filename.replace(/[/\\]/g, "_");
      const rawPath = path.join(rawDir, safe);
      fs.writeFileSync(rawPath, got.buffer);

      const extracted = await extractText(rawPath);
      results.push({
        course: code,
        materialName: material.name,
        filename: got.filename,
        url: material.url,
        score,
        savedTo: rawPath,
        chars: extracted.text.length,
        ok: extracted.ok,
        error: extracted.error,
      });

      if (extracted.ok && extracted.text.trim()) {
        sections.push(
          `## ${material.name}\n\n` +
            `_Source: ${got.filename}` +
            (extracted.pages ? ` · ${extracted.pages} page(s)` : "") +
            `_  \n_Link: ${material.url}_\n\n` +
            "```\n" +
            extracted.text.trim() +
            "\n```\n"
        );
      } else if (!extracted.ok) {
        sections.push(
          `## ${material.name}\n\n_Source: ${got.filename} — could not be transcribed: ${extracted.error}_  \n` +
            `_Saved at: ${rawPath}_\n`
        );
      }
      logger.info(
        `  Syllabus ${code}: ${got.filename} (${extracted.text.length} chars)`
      );
    }

    if (sections.length) {
      fs.mkdirSync(courseDir, { recursive: true });
      const md =
        `# ${code} — Syllabus & Schedule Documents\n` +
        `_Auto-extracted: ${new Date().toISOString()}_\n\n` +
        sections.join("\n---\n\n");
      fs.writeFileSync(path.join(courseDir, "syllabus.md"), md);
    }
  }

  return results;
}

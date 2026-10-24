/**
 * Text extraction for syllabus/schedule documents.
 *
 * Everything here runs in-process. The VPS has no poppler, no LibreOffice and
 * no root to install them, so PDFs go through pdfjs and the XML-in-ZIP formats
 * (.docx, .hwpx, .pptx) go through a small ZIP reader built on node:zlib.
 * Legacy binary .hwp is an OLE compound file and is deliberately not parsed —
 * it is reported as unsupported rather than turned into mojibake.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export interface ExtractResult {
  text: string;
  pages?: number;
  format: string;
  ok: boolean;
  error?: string;
}

/* ------------------------------------------------------------------ ZIP --- */

interface ZipEntry {
  name: string;
  data: Buffer;
}

const MAX_ZIP_ENTRIES = 2_000;
const MAX_ZIP_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 60 * 1024 * 1024;

/**
 * Minimal ZIP reader: walks the End of Central Directory record, then each
 * central-directory header, and inflates stored/deflated entries.
 */
function readZip(buf: Buffer): ZipEntry[] {
  // Locate End of Central Directory (0x06054b50), scanning back over the comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 66_000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");

  const count = Math.min(buf.readUInt16LE(eocd + 10), MAX_ZIP_ENTRIES);
  let ptr = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  let totalOutput = 0;

  for (let i = 0; i < count; i++) {
    if (ptr < 0 || ptr + 46 > buf.length) break;
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const uncompSize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    if (uncompSize > MAX_ZIP_ENTRY_BYTES || totalOutput + uncompSize > MAX_ZIP_TOTAL_BYTES) {
      throw new Error("archive expands beyond the safe extraction limit");
    }
    if (localOff < 0 || localOff + 30 > buf.length) break;
    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString("utf8");

    // Re-read the sizes from the local header; its extra field length differs.
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    if (dataStart < 0 || dataStart + compSize > buf.length) break;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    try {
      if (method !== 0 && method !== 8) throw new Error(`unsupported zip compression method ${method}`);
      const data = method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: MAX_ZIP_ENTRY_BYTES });
      totalOutput += data.length;
      if (totalOutput > MAX_ZIP_TOTAL_BYTES) throw new Error("archive expands beyond the safe extraction limit");
      entries.push({ name, data });
    } catch {
      /* skip entries we cannot inflate */
    }

    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Strip XML tags, turning paragraph/break boundaries into newlines. */
function xmlToText(xml: string): string {
  return xml
    .replace(/<\/w:p>|<\/text:p>|<\/a:p>|<w:br\s*\/>|<text:line-break\s*\/>/g, "\n")
    .replace(/<w:tab\s*\/>|<text:tab\s*\/>/g, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function extractZipXml(buf: Buffer, members: RegExp): string {
  const entries = readZip(buf)
    .filter((e) => members.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return entries.map((e) => xmlToText(e.data.toString("utf8"))).join("\n\n");
}

/* ------------------------------------------------------------------ PDF --- */

async function extractPdf(buf: Buffer): Promise<ExtractResult> {
  // pdfjs is ESM-only and expects a Uint8Array it is allowed to transfer.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: false,
    isEvalSupported: false,
    // No worker thread: this runs inside a short-lived sync job.
    disableFontFace: true,
  }).promise;

  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = "";
    const lines: string[] = [];
    for (const item of content.items) {
      if (!("str" in item)) continue;
      line += item.str;
      if (item.hasEOL) {
        lines.push(line);
        line = "";
      }
    }
    if (line) lines.push(line);
    parts.push(lines.join("\n"));
    page.cleanup();
  }
  await doc.destroy();

  return {
    text: parts.join("\n\n---\n\n").replace(/\n{3,}/g, "\n\n").trim(),
    pages: doc.numPages,
    format: "pdf",
    ok: true,
  };
}

/* --------------------------------------------------------------- public --- */

export async function extractText(file: string): Promise<ExtractResult> {
  const ext = path.extname(file).toLowerCase();
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return { text: "", format: ext, ok: false, error: (e as Error).message };
  }
  return extractBuffer(buf, ext);
}

/**
 * The same dispatch over bytes already in memory.
 *
 * `learnus_fetch_url` downloads attachments through the authenticated browser
 * context, so the bytes never need to touch disk first just to be read.
 */
export async function extractBuffer(buf: Buffer, extension: string): Promise<ExtractResult> {
  const ext = extension.toLowerCase().startsWith(".")
    ? extension.toLowerCase()
    : `.${extension.toLowerCase()}`;

  try {
    switch (ext) {
      case ".pdf":
        return await extractPdf(buf);
      case ".docx":
        return {
          text: extractZipXml(buf, /^word\/(document|header\d*|footer\d*)\.xml$/).trim(),
          format: "docx",
          ok: true,
        };
      case ".pptx":
        return {
          text: extractZipXml(buf, /^ppt\/slides\/slide\d+\.xml$/).trim(),
          format: "pptx",
          ok: true,
        };
      case ".hwpx":
        return {
          text: extractZipXml(buf, /^Contents\/section\d+\.xml$/).trim(),
          format: "hwpx",
          ok: true,
        };
      case ".odt":
        return {
          text: extractZipXml(buf, /^content\.xml$/).trim(),
          format: "odt",
          ok: true,
        };
      case ".txt":
      case ".md":
      case ".csv":
        return { text: buf.toString("utf8"), format: ext.slice(1), ok: true };
      case ".hwp":
        return {
          text: "",
          format: "hwp",
          ok: false,
          error:
            "Legacy binary .hwp is not parseable here (OLE compound format, no converter installed). Open the original file.",
        };
      default:
        return { text: "", format: ext || "unknown", ok: false, error: `Unsupported type ${ext}` };
    }
  } catch (e) {
    return { text: "", format: ext, ok: false, error: (e as Error).message };
  }
}

/** File types worth downloading when hunting for a syllabus. */
export const EXTRACTABLE = new Set([
  ".pdf",
  ".docx",
  ".pptx",
  ".hwpx",
  ".odt",
  ".txt",
  ".md",
  ".csv",
  ".hwp",
]);

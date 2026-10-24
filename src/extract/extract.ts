/**
 * HTML -> dense Markdown, plus structured link/table extraction.
 *
 * The pipeline is three stages, each doing the job it is actually good at:
 *
 *   1. cheerio pre-clean (fast, string-level): drop the elements that are
 *      never content — scripts, styles, nav, cookie banners, share widgets.
 *      Doing this before Readability matters: Readability scores candidate
 *      nodes by text density, and a fat cookie-consent <div> full of prose can
 *      genuinely outscore the article on a thin page.
 *   2. Readability (jsdom): Mozilla's reader-mode algorithm picks the article
 *      subtree. This is what separates "the article" from "the page".
 *   3. Turndown + GFM: HTML -> Markdown with real pipe tables, so numeric
 *      comparison data survives into the model's context instead of collapsing
 *      into an unreadable run of numbers.
 *
 * A page that defeats Readability (docs sites, wikis with unusual markup,
 * search result pages) falls back to a density-scored container pick rather
 * than returning nothing.
 */

import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import TurndownService from "turndown";
import { MAX_PAGE_CHARS } from "./config.js";

/** Elements that are never article content. */
const DROP_TAGS = [
  "script", "style", "noscript", "template", "svg", "canvas", "iframe", "object",
  "embed", "form", "button", "input", "select", "textarea", "video", "audio",
  "picture", "source", "link", "meta",
];

const DROP_SELECTORS = [
  "nav", "header", "footer", "aside",
  "[role=navigation]", "[role=banner]", "[role=complementary]", "[role=search]",
  "[role=contentinfo]", "[role=dialog]", "[role=alertdialog]",
  "[aria-hidden=true]", "[hidden]",
];

/**
 * Class/id substrings that mark chrome. Matched case-insensitively against the
 * element's class and id. Kept as one regex because this runs on every element
 * of every crawled page.
 */
const NOISE_PATTERN =
  /(^|[-_\s])(ad|ads|adsense|advert|advertisement|sponsor|sponsored|promo|banner|popup|modal|overlay|interstitial|cookie|consent|gdpr|newsletter|subscribe|signup|paywall|breadcrumb|sidebar|side-bar|widget|share|sharing|social|follow|related|recommend|trending|popular|comment|comments|disqus|nav|navbar|navigation|menu|masthead|topbar|toolbar|footer|copyright|legal|skip-link|screen-reader|sr-only|visually-hidden|back-to-top|pagination|tag-cloud|author-box|newsletter-signup)([-_\s]|$)/i;

/** Class/id substrings that mark content — these win over NOISE_PATTERN. */
const CONTENT_PATTERN =
  /(^|[-_\s])(article|articlebody|post-content|postcontent|entry-content|main-content|maincontent|content-body|story|story-body|blog-post|markdown-body|prose|documentation|doc-content|mw-parser-output)([-_\s]|$)/i;

export interface PageMetadata {
  title: string;
  description: string;
  siteName: string;
  author: string;
  publishedTime: string;
  canonicalUrl: string;
  lang: string;
}

export interface ExtractedLink {
  url: string;
  text: string;
  internal: boolean;
  /** Where on the page the link was found, used as a weak citation signal. */
  context: "content" | "reference" | "other";
}

export interface ExtractedTable {
  caption: string;
  markdown: string;
  rows: number;
  columns: number;
}

export interface ExtractedPage {
  metadata: PageMetadata;
  /** Main article as Markdown. Empty when nothing article-like was found. */
  markdown: string;
  /** Plain text of the article, for scoring. */
  text: string;
  links: ExtractedLink[];
  tables: ExtractedTable[];
  /** True when Readability succeeded; false means the density fallback ran. */
  readabilityUsed: boolean;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Turndown
// ---------------------------------------------------------------------------

let turndownSingleton: TurndownService | null = null;

async function getTurndown(): Promise<TurndownService> {
  if (turndownSingleton) return turndownSingleton;

  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    linkStyle: "inlined",
  });

  const gfm = (await import("turndown-plugin-gfm")) as unknown as {
    gfm?: TurndownService.Plugin;
    default?: { gfm?: TurndownService.Plugin };
  };
  const plugin = gfm.gfm ?? gfm.default?.gfm;
  if (plugin) service.use(plugin);

  // Images are pure token cost in a text research context; keep the alt text
  // only when it carries meaning (chart labels, figure captions).
  service.addRule("images", {
    filter: "img",
    replacement: (_content, node) => {
      const alt = (node as unknown as { getAttribute(name: string): string | null }).getAttribute("alt") ?? "";
      return alt.trim().length > 12 ? `\n[image: ${alt.trim()}]\n` : "";
    },
  });

  // Anchors that carry no text (icon links, anchors) become nothing.
  service.addRule("emptyLinks", {
    filter: (node) => node.nodeName === "A" && !node.textContent?.trim(),
    replacement: () => "",
  });

  turndownSingleton = service;
  return service;
}

// ---------------------------------------------------------------------------
// Cleaning
// ---------------------------------------------------------------------------

/**
 * Tags that carry structure, not chrome. Removing one of these because of a
 * class name is always a bug, never a cleanup.
 *
 * This guard is not hypothetical: Wikipedia ships `<html class="... vector-
 * feature-main-menu-pinned-disabled ...">`, whose `-menu-` segment matches
 * NOISE_PATTERN. Without this list the very first element visited deletes the
 * entire document and every page extracts as zero characters.
 */
const STRUCTURAL_TAGS = new Set(["html", "body", "main", "article", "section"]);

/**
 * Share of the page's text above which an element is assumed to *be* the page
 * rather than a widget on it. Real chrome — a nav bar, a share rail, a cookie
 * banner — is a small fraction of a document's text; anything holding a third
 * of it is the content column no matter what its class is called.
 */
const NOISE_TEXT_SHARE_LIMIT = 0.35;

function stripNoise($: CheerioAPI): void {
  $(DROP_TAGS.join(",")).remove();
  $(DROP_SELECTORS.join(",")).remove();

  const totalText = $("body").text().replace(/\s+/g, " ").trim().length;

  $("[class],[id]").each((_i, el) => {
    const element = $(el);

    // An earlier iteration may have removed this node's ancestor. Cheerio still
    // hands us the detached node; re-checking keeps the text accounting honest.
    if (!element.closest("body").length && !element.is("body, html")) return;

    const tag = (el as { tagName?: string }).tagName?.toLowerCase() ?? "";
    if (STRUCTURAL_TAGS.has(tag)) return;

    const signature = `${element.attr("class") ?? ""} ${element.attr("id") ?? ""}`;
    if (!signature.trim()) return;
    if (CONTENT_PATTERN.test(signature)) return;
    if (!NOISE_PATTERN.test(signature)) return;

    // Never let a class name outvote the actual content. A wrapper matching
    // "related"/"menu"/"social" that nonetheless holds most of the page's prose
    // is a false positive, and dropping it costs the whole article.
    if (totalText > 0) {
      const ownText = element.text().replace(/\s+/g, " ").trim().length;
      if (ownText / totalText > NOISE_TEXT_SHARE_LIMIT) return;
    }

    // A chrome-named ancestor wrapping a content-named subtree (common on CMS
    // themes) should lose only its own wrapper, not the article inside it.
    if (element.find("[class],[id]").filter((_j, child) => {
      const childSig = `${$(child).attr("class") ?? ""} ${$(child).attr("id") ?? ""}`;
      return CONTENT_PATTERN.test(childSig);
    }).length) {
      return;
    }

    element.remove();
  });

  // Comment nodes occasionally hold entire hidden templates.
  $("*")
    .contents()
    .each((_i, node) => {
      if (node.type === "comment") $(node).remove();
    });
}

export function readMetadata(html: string, url: string): PageMetadata {
  const $ = cheerio.load(html);
  const meta = (names: string[]): string => {
    for (const name of names) {
      const value =
        $(`meta[property="${name}"]`).attr("content") ??
        $(`meta[name="${name}"]`).attr("content") ??
        $(`meta[itemprop="${name}"]`).attr("content");
      if (value?.trim()) return value.trim();
    }
    return "";
  };

  return {
    title: (meta(["og:title", "twitter:title"]) || $("title").first().text() || $("h1").first().text()).trim().slice(0, 300),
    description: meta(["description", "og:description", "twitter:description"]).slice(0, 500),
    siteName: meta(["og:site_name", "application-name"]) || safeHost(url),
    author: meta(["author", "article:author", "og:article:author", "twitter:creator"]).slice(0, 200),
    publishedTime: meta([
      "article:published_time",
      "og:article:published_time",
      "datePublished",
      "publish-date",
      "date",
    ]).slice(0, 60),
    canonicalUrl: $('link[rel="canonical"]').attr("href")?.trim() || url,
    lang: $("html").attr("lang")?.trim().slice(0, 12) ?? "",
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Density fallback for pages Readability gives up on: score every plausible
 * container by text length discounted by link density (a nav block is almost
 * all link text; an article is almost none) and keep the winner.
 */
function densityPick($: CheerioAPI): string {
  const candidates = $("article, main, [role=main], .content, #content, .post, .entry, section, div");
  let bestHtml = "";
  let bestScore = 0;

  candidates.each((_i, el) => {
    const element = $(el);
    const text = element.text().replace(/\s+/g, " ").trim();
    if (text.length < 200) return;
    const linkText = element.find("a").text().replace(/\s+/g, " ").trim().length;
    const linkDensity = linkText / Math.max(text.length, 1);
    if (linkDensity > 0.45) return;
    const paragraphs = element.find("p").length;
    const score = text.length * (1 - linkDensity) * (1 + Math.min(paragraphs, 20) / 20);
    if (score > bestScore) {
      bestScore = score;
      bestHtml = element.html() ?? "";
    }
  });

  return bestHtml || $("body").html() || "";
}

async function runReadability(html: string, url: string): Promise<{ html: string; text: string; byline: string } | null> {
  try {
    const { JSDOM, VirtualConsole } = await import("jsdom");
    // jsdom logs every CSS parse error and unimplemented API on real-world
    // pages; without this a single crawl floods stderr with hundreds of lines.
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("error", () => {});
    virtualConsole.on("warn", () => {});
    virtualConsole.on("jsdomError", () => {});

    const dom = new JSDOM(html, { url, virtualConsole, runScripts: "outside-only", pretendToBeVisual: false });
    const { Readability, isProbablyReaderable } = await import("@mozilla/readability");

    const document = dom.window.document;
    const readerable = isProbablyReaderable(document, { minContentLength: 120, minScore: 18 });
    const article = new Readability(document, {
      charThreshold: 250,
      keepClasses: false,
      nbTopCandidates: 6,
    }).parse();

    dom.window.close();

    if (!article?.content) return null;
    const text = (article.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!readerable && text.length < 400) return null;
    return { html: article.content, text, byline: article.byline ?? "" };
  } catch {
    return null;
  }
}

/** Collapses the whitespace Turndown leaves behind on real-world markup. */
function tidyMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s*[-*]\s*$/gm, "")
    .replace(/\[\s*\]\([^)]*\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Links & tables
// ---------------------------------------------------------------------------

const JUNK_ANCHOR =
  /^(home|menu|search|login|log in|sign in|sign up|register|subscribe|share|tweet|print|next|previous|prev|back|top|more|read more|click here|contact|about|privacy|terms|cookies?|accept|close|skip to content|advertisement)$/i;

export function extractLinks(html: string, baseUrl: string, limit = 200): ExtractedLink[] {
  const $ = cheerio.load(html);
  const base = (() => {
    try {
      return new URL(baseUrl);
    } catch {
      return null;
    }
  })();

  const seen = new Set<string>();
  const links: ExtractedLink[] = [];

  $("a[href]").each((_i, el) => {
    if (links.length >= limit) return false;
    const element = $(el);
    const href = element.attr("href")?.trim();
    if (!href || href.startsWith("#") || /^(javascript|mailto|tel|data):/i.test(href)) return;

    let resolved: URL;
    try {
      resolved = base ? new URL(href, base) : new URL(href);
    } catch {
      return;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return;
    resolved.hash = "";

    const key = resolved.toString();
    if (seen.has(key)) return;
    seen.add(key);

    const text = element.text().replace(/\s+/g, " ").trim().slice(0, 220);
    if (!text || JUNK_ANCHOR.test(text)) return;

    // Reference sections and footnote markup are the strongest citation signal
    // a page offers; keep that provenance for the crawler's link scoring.
    const inReference = element.parents("ol,ul,li,cite,.references,.reflist,#references,.citation,.footnotes").length > 0;
    const inContent = element.parents("article,main,[role=main],p,.content,.post,.entry,.markdown-body").length > 0;

    links.push({
      url: key,
      text,
      internal: base ? resolved.hostname === base.hostname : false,
      context: inReference ? "reference" : inContent ? "content" : "other",
    });
  });

  return links;
}

export function extractTables(html: string, limit = 12): ExtractedTable[] {
  const $ = cheerio.load(html);
  // Tables are read from the *original* HTML (the noise strip can legitimately
  // remove a container holding a real data table), so they have not been
  // through DROP_TAGS. Wikipedia inlines <style> inside header cells, which
  // otherwise renders raw CSS — "@supports(writing-mode:vertical-rl){…}" — as a
  // column name.
  $("table script, table style, table noscript").remove();
  const tables: ExtractedTable[] = [];

  $("table").each((_i, el) => {
    if (tables.length >= limit) return false;
    const table = $(el);

    // Presentational and boilerplate tables. Wikipedia's maintenance banners
    // ("This article needs more citations…") are real <table> elements, and
    // without this they extract as table #1 on a huge share of wiki pages —
    // pushing the actual data tables past the limit.
    if (table.attr("role") === "presentation" || table.attr("role") === "none") return;
    const tableSig = `${table.attr("class") ?? ""} ${table.attr("id") ?? ""}`;
    if (/\b(ambox|mbox|tmbox|ombox|cmbox|fmbox|imbox|metadata|navbox|vertical-navbox|sistersitebox|plainlinks|nomobile|noprint|toc|hatnote)\b/i.test(tableSig)) return;
    // A table nested inside another table is layout scaffolding.
    if (table.parents("table").length) return;

    const rows: string[][] = [];
    table.find("tr").each((_j, tr) => {
      const cells: string[] = [];
      $(tr)
        .find("th,td")
        .each((_k, cell) => {
          cells.push(
            $(cell)
              .text()
              .replace(/\s+/g, " ")
              .replace(/\|/g, "\\|")
              .trim()
          );
        });
      if (cells.some((c) => c.length > 0)) rows.push(cells);
    });

    // Layout tables (still common on older sites) have one column or one row.
    if (rows.length < 2) return;
    const columns = Math.max(...rows.map((r) => r.length));
    if (columns < 2) return;

    // Data tables hold short values; a "table" whose average cell is a
    // paragraph is prose that happens to be laid out in a grid, and rendering
    // it as Markdown pipes produces an unreadable wall.
    const cellTexts = rows.flat().filter((c) => c.length > 0);
    if (!cellTexts.length) return;
    const averageCell = cellTexts.reduce((sum, c) => sum + c.length, 0) / cellTexts.length;
    if (averageCell > 200) return;

    // Mostly-empty grids are spacer layout, not data.
    if (cellTexts.length < rows.length * columns * 0.35) return;

    const normalized = rows.map((r) => {
      const copy = [...r];
      while (copy.length < columns) copy.push("");
      return copy.slice(0, columns);
    });

    const [header, ...body] = normalized;
    const markdown = [
      `| ${header!.join(" | ")} |`,
      `| ${header!.map(() => "---").join(" | ")} |`,
      ...body.slice(0, 60).map((r) => `| ${r.join(" | ")} |`),
    ].join("\n");

    const caption =
      table.find("caption").first().text().replace(/\s+/g, " ").trim() ||
      table.prevAll("h1,h2,h3,h4,p").first().text().replace(/\s+/g, " ").trim().slice(0, 160) ||
      "";

    tables.push({ caption, markdown, rows: normalized.length, columns });
  });

  return tables;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface ExtractOptions {
  /** Cap on the returned markdown. Defaults to MAX_PAGE_CHARS. */
  maxChars?: number;
  includeLinks?: boolean;
  includeTables?: boolean;
}

export async function extractPage(html: string, url: string, options: ExtractOptions = {}): Promise<ExtractedPage> {
  const maxChars = options.maxChars ?? MAX_PAGE_CHARS;
  const metadata = readMetadata(html, url);

  // Links and tables come from the *original* HTML: the noise strip removes
  // navigation, and a table of contents or a citation list can legitimately
  // live in a stripped container.
  const links = options.includeLinks === false ? [] : extractLinks(html, url);
  const tables = options.includeTables === false ? [] : extractTables(html);

  const originalText = cheerio.load(html)("body").text().replace(/\s+/g, " ").trim().length;

  let $ = cheerio.load(html);
  stripNoise($);
  let cleanedText = $("body").text().replace(/\s+/g, " ").trim().length;

  // Safety net. Cleaning is a heuristic over class names that every site is
  // free to choose adversarially, so it can always be wrong on some page. If it
  // took out more than ~92% of the text, it did not clean the page — it deleted
  // it, and an uncleaned article beats a perfectly-stripped empty string.
  if (originalText > 0 && cleanedText < originalText * 0.08) {
    $ = cheerio.load(html);
    $(DROP_TAGS.join(",")).remove();
    cleanedText = $("body").text().replace(/\s+/g, " ").trim().length;
  }

  const cleanedHtml = $.html();

  const readable = await runReadability(cleanedHtml, url);
  const articleHtml = readable?.html ?? densityPick($);

  const turndown = await getTurndown();
  let markdown = "";
  try {
    markdown = tidyMarkdown(turndown.turndown(articleHtml));
  } catch {
    markdown = tidyMarkdown(cheerio.load(articleHtml).text());
  }

  const truncated = markdown.length > maxChars;
  if (truncated) markdown = `${markdown.slice(0, maxChars)}\n\n_[truncated]_`;

  const text = readable?.text ?? markdown.replace(/[#*_`>|\[\]()-]/g, " ").replace(/\s+/g, " ").trim();

  if (!metadata.author && readable?.byline) metadata.author = readable.byline.slice(0, 200);

  return {
    metadata,
    markdown,
    text,
    links,
    tables,
    readabilityUsed: Boolean(readable),
    truncated,
  };
}

/** Plain-text conversion for non-HTML documents (txt, csv, json, xml). */
export function plainTextDocument(body: string, maxChars: number): { markdown: string; truncated: boolean } {
  const cleaned = body.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (cleaned.length <= maxChars) return { markdown: cleaned, truncated: false };
  return { markdown: `${cleaned.slice(0, maxChars)}\n\n_[truncated]_`, truncated: true };
}

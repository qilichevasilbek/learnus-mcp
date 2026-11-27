/**
 * Authenticated transport to Yonsei's academic system (underwood1.yonsei.ac.kr).
 *
 * underwood1 is its own Yonsei SSO client (app id `haksaYonsei`) on the same
 * `infra.yonsei.ac.kr` SSO that LearnUS uses. So: sign in to LearnUS as the
 * scraper already does (that leaves the SSO session in the browser context),
 * then open `SSOLegacy.do?pname=spLogin`, which round-trips through the SSO and
 * starts an underwood1 session. Requests are then sent with `fetch` from a page
 * on underwood1 — same origin and same cookies as the real page, which is the
 * only path observed working.
 *
 * Two traps on this site:
 * - Signed out, it still answers HTTP 200 (JSON `P000000-0096`, or an HTML
 *   page that alerts "SSO 인증정보가 없습니다"). parse.ts turns both into a
 *   session error; the caller re-opens the session once.
 * - That HTML page then navigates to `SSOLegacy.do?pname=spLogout`, which would
 *   end the SSO session the LearnUS tools also rely on. Navigation there is
 *   blocked.
 */
import type { Page } from "playwright";
import * as browser from "../learnus/browser.js";
import { login } from "../learnus/auth.js";
import * as config from "../learnus/config.js";
import { logger } from "../learnus/logger.js";
import { SeminarRoomError } from "./parse.js";

export const PORTAL_BASE = "https://underwood1.yonsei.ac.kr";
const HOST = new URL(PORTAL_BASE).host;

/** What the dorm service needs from the network. Tests pass a fake. */
export interface Transport {
  /** POST a form body to a path on underwood1; resolves with the raw response text. */
  post(path: string, body: string): Promise<string>;
  /** Drop the current portal session so the next post signs in again. */
  reset(options?: { fresh?: boolean }): Promise<void>;
}

let page: Page | null = null;
let freshNext = false;

async function openPortal(fresh: boolean): Promise<Page> {
  const { context } = await browser.launch();
  await login(context, { fresh });
  const p = await context.newPage();
  // Never let a failed SSO hop sign the shared session out.
  await p.route(/SSOLegacy\.do\?pname=spLogout/, (route) => route.abort());
  p.on("dialog", (d) => void d.dismiss().catch(() => {}));

  await p.goto(`${PORTAL_BASE}/SSOLegacy.do?pname=spLogin`, { waitUntil: "domcontentloaded", timeout: config.NAV_TIMEOUT });
  await p.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  let host = new URL(p.url()).host;
  if (host !== HOST) {
    // Still on the SSO: it wants a fresh sign-in.
    await p.close().catch(() => {});
    throw new SeminarRoomError("session", `Yonsei SSO did not hand a session to the academic portal (stopped at ${host}). Run \`node dist/server.js login\` again.`);
  }
  // The portal itself opens the app this way after SSO; it creates the app session.
  await p.goto(`${PORTAL_BASE}/com/lgin/SsoCtr/j_login_sso.do?locale=ko`, { waitUntil: "domcontentloaded", timeout: config.NAV_TIMEOUT }).catch(() => {});
  await p.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  host = new URL(p.url()).host;
  if (host !== HOST) {
    await p.goto(PORTAL_BASE + "/", { waitUntil: "domcontentloaded", timeout: config.NAV_TIMEOUT }).catch(() => {});
  }
  logger.info(`Academic portal opened (${new URL(p.url()).pathname})`);
  return p;
}

export const portalTransport: Transport = {
  async post(path, body) {
    if (!page || page.isClosed()) {
      page = await openPortal(freshNext);
      freshNext = false;
    }
    const res = await page.evaluate(
      async ({ path, body }) => {
        const r = await fetch(path, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8", "X-Requested-With": "XMLHttpRequest" },
          body,
        });
        return { status: r.status, text: await r.text() };
      },
      { path, body }
    );
    // Log the endpoint and status only: bodies carry the student number.
    logger.info(`portal ${path.split("/").pop()} → ${res.status}`);
    if (res.status >= 500) throw new SeminarRoomError("rejected", `The academic portal failed with HTTP ${res.status} on ${path}.`);
    if (res.status >= 400) throw new SeminarRoomError("layout", `The academic portal answered HTTP ${res.status} on ${path}; the endpoint may have moved.`);
    return res.text;
  },
  async reset(options = {}) {
    if (page && !page.isClosed()) await page.close().catch(() => {});
    page = null;
    freshNext = Boolean(options.fresh);
  },
};

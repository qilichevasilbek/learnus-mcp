import fs from "node:fs";
import type { BrowserContext } from "playwright";
import * as config from "./config.js";
import { logger } from "./logger.js";

interface SessionData {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>;
  savedAt: string;
}

export async function saveCookies(context: BrowserContext): Promise<void> {
  const cookies = await context.cookies();
  const data: SessionData = { cookies, savedAt: new Date().toISOString() };
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  fs.writeFileSync(config.SESSION_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  logger.info(`Session saved (${cookies.length} cookies)`);
}

export async function loadCookies(
  context: BrowserContext
): Promise<boolean> {
  if (!fs.existsSync(config.SESSION_FILE)) return false;
  try {
    const data: SessionData = JSON.parse(
      fs.readFileSync(config.SESSION_FILE, "utf-8")
    );
    const age = Date.now() - new Date(data.savedAt).getTime();
    if (age > 4 * 60 * 60 * 1000) {
      logger.info("Saved session expired (>4 hours), will re-login");
      return false;
    }
    await context.addCookies(data.cookies);
    logger.info("Loaded saved session cookies");
    return true;
  } catch (e) {
    logger.warn("Failed to load session:", (e as Error).message);
    return false;
  }
}

export async function isSessionValid(
  context: BrowserContext
): Promise<boolean> {
  const page = await context.newPage();
  try {
    await page.goto(config.LEARNUS_BASE + "/my/", {
      waitUntil: "domcontentloaded",
      timeout: config.NAV_TIMEOUT,
    });
    const url = page.url();
    const valid = url.includes("/my/") && !url.includes("login");
    if (valid) logger.info("Existing session is valid");
    return valid;
  } catch {
    return false;
  } finally {
    await page.close();
  }
}

export async function extractSesskey(
  context: BrowserContext
): Promise<string | null> {
  const page = await context.newPage();
  try {
    await page.goto(config.LEARNUS_BASE + "/my/", {
      waitUntil: "domcontentloaded",
      timeout: config.NAV_TIMEOUT,
    });
    const sesskey = await page.evaluate(() => {
      const w = window as unknown as {
        M?: { cfg?: { sesskey?: string } };
      };
      return w.M?.cfg?.sesskey ?? null;
    });
    return sesskey;
  } finally {
    await page.close();
  }
}

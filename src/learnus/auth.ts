import fs from "node:fs";
import type { BrowserContext } from "playwright";
import * as config from "./config.js";
import * as session from "./session.js";
import { logger } from "./logger.js";

export async function login(context: BrowserContext): Promise<string> {
  // Try loading existing session
  const loaded = await session.loadCookies(context);
  if (loaded && (await session.isSessionValid(context))) {
    logger.info("Using existing valid session");
    const sesskey = await session.extractSesskey(context);
    if (sesskey) return sesskey;
  }

  logger.info("Starting fresh SSO login...");
  return loginSSO(context);
}

async function loginSSO(context: BrowserContext): Promise<string> {
  const page = await context.newPage();
  try {
    // Navigate to LearnUs main page
    await page.goto(config.LEARNUS_BASE + "/", {
      waitUntil: "networkidle",
      timeout: config.NAV_TIMEOUT,
    });
    logger.info(`Landing page: ${page.url()}`);

    // Click the SSO login button
    await Promise.all([
      page.waitForNavigation({ timeout: 30000, waitUntil: "domcontentloaded" }),
      page.click("a.btn.btn-sso"),
    ]);
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    logger.info(`SSO page: ${page.url()}`);
    await page.screenshot({ path: config.LOGS_DIR + "/01-sso-page.png", fullPage: true });

    if (!page.url().includes("infra.yonsei.ac.kr")) {
      throw new Error(`Expected Yonsei SSO page, got: ${page.url()}`);
    }

    // Fill in the login form
    await page.waitForSelector("#loginId", { timeout: 10000 });
    await page.fill("#loginId", config.STUDENT_ID);
    await page.fill("#loginPasswd", config.STUDENT_PW);

    await page.screenshot({ path: config.LOGS_DIR + "/02-sso-filled.png", fullPage: true });
    logger.info("SSO form filled");

    // Submit via RSA-encrypted JS function
    await Promise.all([
      page.waitForNavigation({ timeout: 30000, waitUntil: "domcontentloaded" }).catch(() => {}),
      page.evaluate(() => {
        (window as unknown as { fSubmitSSOLoginForm2: () => void }).fSubmitSSOLoginForm2();
      }),
    ]);
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});

    logger.info(`After SSO submit: ${page.url()}`);
    await page.screenshot({ path: config.LOGS_DIR + "/03-after-sso.png", fullPage: true });

    const currentUrl = page.url();

    if (currentUrl.includes("infra.yonsei.ac.kr")) {
      const errorText = await page
        .evaluate(() => {
          const info = document.getElementById("info");
          return info ? info.textContent?.trim() ?? "" : "";
        })
        .catch(() => "");

      const html = await page.content();
      fs.writeFileSync(config.LOGS_DIR + "/sso-error-page.html", html.substring(0, 10000));
      throw new Error(`SSO login failed. Still on SSO page. Error: ${errorText}`);
    }

    // Navigate to /my/ to verify auth and get sesskey
    if (!currentUrl.includes("/my/")) {
      await page.goto(config.LEARNUS_BASE + "/my/", {
        waitUntil: "domcontentloaded",
        timeout: config.NAV_TIMEOUT,
      });
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    }

    logger.info(`Dashboard: ${page.url()}`);
    await page.screenshot({ path: config.LOGS_DIR + "/04-dashboard.png", fullPage: true });

    if (page.url().includes("login")) {
      throw new Error("SSO completed but not authenticated on LearnUs");
    }

    // Extract sesskey
    const sesskey = await page.evaluate(() => {
      const w = window as unknown as { M?: { cfg?: { sesskey?: string } } };
      if (w.M?.cfg?.sesskey) return w.M.cfg.sesskey;
      const match = document.documentElement.innerHTML.match(/"sesskey"\s*:\s*"([^"]+)"/);
      return match ? match[1] : null;
    });

    if (!sesskey) {
      const sesskeyFromLink = await page.evaluate(() => {
        const link = document.querySelector('a[href*="sesskey="]') as HTMLAnchorElement | null;
        if (link) {
          const m = link.href.match(/sesskey=([a-zA-Z0-9]+)/);
          return m ? m[1] : null;
        }
        return null;
      });

      if (sesskeyFromLink) {
        await session.saveCookies(context);
        logger.info("SSO login successful! (sesskey from link)");
        return sesskeyFromLink;
      }

      const html = await page.content();
      fs.writeFileSync(config.LOGS_DIR + "/debug-dashboard.html", html.substring(0, 10000));
      throw new Error("Could not extract sesskey after SSO login");
    }

    await session.saveCookies(context);
    logger.info("SSO login successful!");
    return sesskey;
  } catch (error) {
    await page
      .screenshot({ path: config.LOGS_DIR + "/error-login.png", fullPage: true })
      .catch(() => {});
    logger.error(`Login failed: ${(error as Error).message}`);
    throw error;
  } finally {
    await page.close();
  }
}

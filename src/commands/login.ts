/**
 * `learnus-mcp login` — sign in once so the tools can work unattended.
 *
 *   login            type your Yonsei ID and password; they are checked against
 *                    the real SSO, then saved to the OS keystore
 *   login --browser  a visible browser window opens on LearnUS; you sign in by
 *                    hand (2FA, captcha, anything) and only the session is kept
 *   --no-verify      save without trying the login (e.g. when offline)
 */
import fs from "node:fs";
import { chromium } from "playwright";
import * as config from "../learnus/config.js";
import * as browser from "../learnus/browser.js";
import * as session from "../learnus/session.js";
import { login as ssoLogin } from "../learnus/auth.js";
import { askHidden, ask, interactive } from "../prompt.js";
import { readCredentials, saveCredentials } from "../credentials.js";
import { createFolders } from "./paths.js";

export const PORTAL_LINKS = {
  learnus: config.LEARNUS_BASE,
  attendance: config.ROLLBOOK_BASE,
};

export async function loginCommand(args: string[]): Promise<void> {
  createFolders();
  if (args.includes("--browser")) return browserLogin();

  if (!interactive()) {
    throw new Error(
      "login needs an interactive terminal. In scripts, set YONSEI_ID and YONSEI_PW instead, " +
        "or run `login --browser` from a terminal."
    );
  }

  const existing = readCredentials();
  const id = await ask("Yonsei ID (student number):", existing?.id ?? "");
  if (!id) throw new Error("An ID is required.");
  const pw = await askHidden("Password (typing is hidden):");
  if (!pw) throw new Error("A password is required.");

  if (!args.includes("--no-verify")) {
    console.log("\nChecking the login against Yonsei SSO (takes ~20 seconds)...");
    // A still-valid saved session would be reused and never test the new password.
    fs.rmSync(config.SESSION_FILE, { force: true });
    const previous = { id: process.env.YONSEI_ID, pw: process.env.YONSEI_PW };
    process.env.YONSEI_ID = id;
    process.env.YONSEI_PW = pw;
    try {
      const { context } = await browser.launch();
      await ssoLogin(context);
    } catch (err) {
      throw new Error(
        `Yonsei rejected that login, or the site could not be reached: ${(err as Error).message}\n` +
          "Nothing was saved. Check the ID and password by signing in at " + PORTAL_LINKS.learnus +
          ", or use `login --browser`."
      );
    } finally {
      await browser.close();
      for (const [k, v] of [["YONSEI_ID", previous.id], ["YONSEI_PW", previous.pw]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    console.log("Login works.");
  }

  const where = saveCredentials({ id, pw });
  if (!where) throw new Error("Could not save the credentials anywhere. Set YONSEI_ID and YONSEI_PW instead.");
  console.log(`Saved to: ${where}`);
  if (where === "credentials file") {
    console.log(
      `  (no OS keystore available — stored in a file readable only by you. ` +
        `Install 'libsecret-tools' on Linux for a keyring.)`
    );
  }
  console.log("Next: `node dist/server.js sync` to fill the cache, or just ask your agent.");
}

async function browserLogin(): Promise<void> {
  console.log(`Opening a browser window on ${PORTAL_LINKS.learnus}`);
  console.log("Sign in there (use the Yonsei SSO button). I'll detect it and close the window.\n");

  const b = await chromium.launch({ headless: false });
  try {
    const context = await b.newContext({ locale: "ko-KR", timezoneId: "Asia/Seoul" });
    const page = await context.newPage();
    await page.goto(PORTAL_LINKS.learnus + "/", { waitUntil: "domcontentloaded" });

    // Moodle only renders the logout link for a signed-in user.
    await page.waitForSelector('a[href*="login/logout.php"]', { state: "attached", timeout: 5 * 60 * 1000 });
    await page.goto(PORTAL_LINKS.learnus + "/my/", { waitUntil: "domcontentloaded" });
    // Visiting the portal now lets its own SSO cookie be captured as well.
    await page.goto(PORTAL_LINKS.attendance + "/", { waitUntil: "domcontentloaded" }).catch(() => {});
    await session.saveCookies(context);
    console.log("Signed in. Session saved (valid for about 4 hours).");
    console.log("Note: no password is stored in this mode, so the cache cannot refresh itself after that.");
    console.log("      Use plain `login` to save credentials if you want unattended syncs.");
  } catch (err) {
    if ((err as Error).name === "TimeoutError") {
      throw new Error("No sign-in detected within 5 minutes. Run the command again when you're ready.");
    }
    throw err;
  } finally {
    await b.close();
  }
}

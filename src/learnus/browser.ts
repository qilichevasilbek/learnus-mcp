import { chromium, type Browser, type BrowserContext } from "playwright";
import * as config from "./config.js";

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void close();
  }, IDLE_TIMEOUT_MS);
}

export async function launch(): Promise<{
  browser: Browser;
  context: BrowserContext;
}> {
  if (browser && context) {
    resetIdleTimer();
    return { browser, context };
  }

  browser = await chromium.launch({
    headless: config.HEADLESS,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
  });

  resetIdleTimer();
  return { browser, context };
}

export async function close(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (browser) {
    try {
      await browser.close();
    } catch {
      // ignore
    }
  }
  browser = null;
  context = null;
}

export function getContext(): BrowserContext | null {
  return context;
}

// Clean up on process exit
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());

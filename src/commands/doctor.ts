/** `learnus-mcp doctor` — say what is working and what to run for what is not. */
import fs from "node:fs";
import { chromium } from "playwright";
import * as config from "../learnus/config.js";
import { readSyncState, describeAge } from "../learnus/cache.js";
import { readCredentials } from "../credentials.js";
import { FOLDERS } from "./paths.js";

type Check = { ok: boolean; label: string; fix?: string };

export async function doctorCommand(): Promise<void> {
  const checks: Check[] = [];

  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ ok: major >= 20, label: `Node ${process.versions.node}`, fix: "Install Node 20 or newer (https://nodejs.org)." });

  const missing = FOLDERS.filter((f) => !fs.existsSync(f.dir));
  checks.push({
    ok: missing.length === 0,
    label: `Folders under ${config.HOME_DIR}`,
    fix: "Run `node dist/server.js setup` (it creates them).",
  });

  let chromiumOk = false;
  try {
    chromiumOk = fs.existsSync(chromium.executablePath());
  } catch {
    /* not installed */
  }
  checks.push({ ok: chromiumOk, label: "Chromium for the scraper", fix: "Run `npx playwright install chromium`." });

  const creds = readCredentials();
  checks.push({
    ok: Boolean(creds),
    label: creds ? `Yonsei credentials (${creds.source})` : "Yonsei credentials",
    fix: "Run `node dist/server.js login`.",
  });

  try {
    const age = Date.now() - fs.statSync(config.SESSION_FILE).mtimeMs;
    checks.push({
      ok: age < 4 * 60 * 60 * 1000,
      label: `Saved session (${describeAge(age)})`,
      fix: creds
        ? "Expired sessions renew themselves on the next tool call."
        : "Session expired and no password is saved: run `login` again.",
    });
  } catch {
    checks.push({ ok: Boolean(creds), label: "Saved session (none yet — created on first login)", fix: "Run `node dist/server.js login`." });
  }

  const sync = readSyncState();
  checks.push({
    ok: Boolean(sync && sync.status !== "failed"),
    label: sync ? `Last sync ${describeAge(Date.now() - new Date(sync.finishedAt).getTime())} — ${sync.status}` : "Cache (never synced)",
    fix: "Run `node dist/server.js sync` (or ask your agent to call learnus_sync).",
  });

  for (const [name, url] of [["LearnUS", config.LEARNUS_BASE], ["Attendance portal", config.ROLLBOOK_BASE]] as const) {
    let ok = false;
    try {
      await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8000) });
      ok = true;
    } catch {
      /* unreachable */
    }
    checks.push({ ok, label: `${name} reachable (${url})`, fix: "Check your network connection." });
  }

  for (const c of checks) {
    console.log(`${c.ok ? "✓" : "✗"} ${c.label}`);
    if (!c.ok && c.fix) console.log(`    → ${c.fix}`);
  }
  const bad = checks.filter((c) => !c.ok).length;
  console.log(bad ? `\n${bad} thing(s) need attention.` : "\nAll good.");
  process.exitCode = bad ? 1 : 0;
}

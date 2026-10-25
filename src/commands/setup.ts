/** `learnus-mcp setup` — one guided pass from a fresh clone to a working agent. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";
import * as config from "../learnus/config.js";
import { ask, confirm, interactive } from "../prompt.js";
import { readCredentials } from "../credentials.js";
import { runSync } from "../learnus/sync.js";
import { createFolders, FOLDERS, REPO_ROOT, SERVER_JS } from "./paths.js";
import { loginCommand, PORTAL_LINKS } from "./login.js";

const step = (n: number, title: string) => console.log(`\n[${n}/6] ${title}`);
const ok = (msg: string) => console.log(`  ✓ ${msg}`);

const hasCommand = (cmd: string) =>
  spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;

export async function setupCommand(): Promise<void> {
  if (!interactive()) throw new Error("setup is interactive; run it in a terminal.");
  console.log("learnus-mcp setup — about two minutes.");

  step(1, "Folders");
  const created = createFolders();
  ok(created.length ? `created ${created.length} folder(s)` : "already there");
  for (const f of FOLDERS) console.log(`    ${f.dir}  — ${f.purpose}`);

  step(2, "Browser for the scraper");
  let installed = false;
  try {
    installed = fs.existsSync(chromium.executablePath());
  } catch {
    /* not installed */
  }
  if (installed) ok("Chromium already installed");
  else {
    console.log("  Installing Chromium (~150 MB, one time)...");
    const r = spawnSync("npx", ["playwright", "install", "chromium"], {
      stdio: "inherit",
      cwd: REPO_ROOT,
      shell: process.platform === "win32",
    });
    if (r.status !== 0) throw new Error("Chromium install failed. Run `npx playwright install chromium` and retry.");
    ok("Chromium installed");
  }

  step(3, "Sign in to Yonsei");
  console.log(`  Links: LearnUS ${PORTAL_LINKS.learnus}   Attendance ${PORTAL_LINKS.attendance}`);
  const existing = readCredentials();
  if (existing && (await confirm(`  Credentials already saved (${existing.source}). Keep them?`))) {
    ok("keeping saved credentials");
  } else {
    console.log(`
  1) Save my ID and password securely  (recommended — the cache can refresh itself)
  2) Open a browser window and let me sign in myself  (nothing but a 4-hour session is kept)
  3) Skip for now`);
    const choice = await ask("  Choose 1, 2 or 3:", "1");
    if (choice === "1") await loginCommand([]);
    else if (choice === "2") await loginCommand(["--browser"]);
    else console.log("  Skipped. Run `node dist/server.js login` any time.");
  }

  step(4, "Connect Claude Code");
  if (hasCommand("claude")) {
    if (await confirm("  Register the learnus tools with Claude Code (for all your projects)?")) {
      const r = spawnSync("claude", ["mcp", "add", "learnus", "--scope", "user", "--", "node", SERVER_JS], {
        encoding: "utf8",
      });
      if (r.status === 0) ok("registered as 'learnus'");
      else console.log(`  Could not register (${(r.stderr || r.stdout).trim().split("\n")[0]}). It may already exist: check \`claude mcp list\`.`);
    }
  } else {
    console.log("  Claude Code not found on PATH. For other agents run: node dist/server.js config");
  }

  step(5, "Teach Claude how to use the tools (skill)");
  const skillSrc = path.join(REPO_ROOT, "examples", "claude-skill", "SKILL.md");
  const skillDest = path.join(os.homedir(), ".claude", "skills", "learnus", "SKILL.md");
  if (fs.existsSync(skillSrc) && (await confirm(`  Install the skill to ${skillDest}?`))) {
    fs.mkdirSync(path.dirname(skillDest), { recursive: true });
    fs.copyFileSync(skillSrc, skillDest);
    ok("skill installed");
  }

  step(6, "First sync");
  if (readCredentials() || fs.existsSync(config.SESSION_FILE)) {
    if (await confirm("  Fill the cache now? (60–120 seconds)")) {
      const state = await runSync({});
      ok(`sync ${state.status}: ${state.courseCount} courses`);
      for (const [name, s] of Object.entries(state.steps)) console.log(`    ${s.ok ? "✓" : "✗"} ${name}${s.error ? ` — ${s.error}` : ""}`);
    }
  } else console.log("  Nothing to sync with yet — sign in first.");

  console.log(`
Done. Restart Claude Code, then ask: "what's due this week?"
Check anything with: node dist/server.js doctor`);
}

#!/usr/bin/env node
/**
 * learnus-mcp — Yonsei LearnUS / 전자출결 tools for any MCP-capable agent.
 *
 *   learnus-mcp                 stdio MCP server (what an agent launches)
 *   learnus-mcp setup           guided first-time setup (folders, browser, login, Claude)
 *   learnus-mcp login           save your ID/password to the OS keystore (verified first)
 *   learnus-mcp login --browser sign in by hand in a visible browser window
 *   learnus-mcp logout          forget saved credentials and session
 *   learnus-mcp sync            one full refresh of the cache (for cron/launchd/systemd)
 *     [--rediscover] [--no-syllabus] [--semester 20262]
 *   learnus-mcp doctor          check what works and what to run for what does not
 *   learnus-mcp config          copy-paste agent configuration snippets
 *
 * stdout is the MCP wire in server mode, so server-mode logging goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const HELP = `learnus-mcp — LearnUS tools for AI agents

  setup            guided first-time setup (start here)
  login            save your Yonsei ID/password securely  [--browser] [--no-verify]
  logout           forget saved credentials and session
  sync             refresh the cache now  [--rediscover] [--no-syllabus] [--semester 20262]
  doctor           check the installation
  config           print agent configuration snippets
  (no command)     run as an MCP server over stdio`;

async function main(): Promise<void> {
  const command = process.argv[2];
  const rest = process.argv.slice(3);

  switch (command) {
    case undefined: {
      const { createLearnusServer } = await import("./learnus/index.js");
      await createLearnusServer().connect(new StdioServerTransport());
      return;
    }
    case "sync": {
      const { runSync } = await import("./learnus/sync.js");
      const state = await runSync({
        semester: arg("semester"),
        rediscover: rest.includes("--rediscover"),
        skipSyllabus: rest.includes("--no-syllabus"),
      });
      console.log(JSON.stringify(state, null, 2));
      // A partial sync (one source down) is still a success; only a fatal one fails.
      process.exit(state.status === "failed" ? 1 : 0);
    }
    case "setup":
      await (await import("./commands/setup.js")).setupCommand();
      process.exit(0);
    case "login":
      await (await import("./commands/login.js")).loginCommand(rest);
      process.exit(0);
    case "logout":
      await (await import("./commands/logout.js")).logoutCommand();
      process.exit(0);
    case "doctor":
      await (await import("./commands/doctor.js")).doctorCommand();
      process.exit(process.exitCode ?? 0);
    case "config":
      (await import("./commands/config.js")).configCommand();
      process.exit(0);
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      process.exit(0);
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

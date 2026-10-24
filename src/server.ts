#!/usr/bin/env node
/**
 * learnus-mcp — Yonsei LearnUS / 전자출결 tools for any MCP-capable agent.
 *
 *   learnus-mcp            stdio MCP server (what an agent launches)
 *   learnus-mcp sync       one full refresh of the cache, then exit (for cron/launchd/systemd)
 *     [--rediscover] [--no-syllabus] [--semester 20262]
 *
 * stdout is the MCP wire in server mode, so everything else goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLearnusServer } from "./learnus/index.js";
import { runSync } from "./learnus/sync.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  if (process.argv[2] === "sync") {
    const state = await runSync({
      semester: arg("semester"),
      rediscover: process.argv.includes("--rediscover"),
      skipSyllabus: process.argv.includes("--no-syllabus"),
    });
    console.log(JSON.stringify(state, null, 2));
    // A partial sync (one source down) is still a success; only a fatal one fails.
    process.exit(state.status === "failed" ? 1 : 0);
  }

  await createLearnusServer().connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("learnus-mcp failed:", err);
  process.exit(1);
});

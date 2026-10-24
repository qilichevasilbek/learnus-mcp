import fs from "node:fs";
import path from "node:path";
import { LOGS_DIR } from "./config.js";

function ensureLogDir() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function timestamp() {
  return new Date().toISOString();
}

function log(level: string, ...args: unknown[]) {
  ensureLogDir();
  const msg = `[${timestamp()}] [${level}] ${args.join(" ")}`;
  // stdout is the MCP wire when this runs as a stdio server; logs go to stderr.
  console.error(msg);
  fs.appendFileSync(path.join(LOGS_DIR, "scraper.log"), msg + "\n");
}

export const logger = {
  info: (...args: unknown[]) => log("INFO", ...args),
  warn: (...args: unknown[]) => log("WARN", ...args),
  error: (...args: unknown[]) => log("ERROR", ...args),
};

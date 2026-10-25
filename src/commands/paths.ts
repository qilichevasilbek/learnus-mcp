import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as config from "../learnus/config.js";

/** The built server, as an agent should launch it. */
export const SERVER_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "server.js");
/** The repository root (dist/commands -> repo). */
export const REPO_ROOT = path.resolve(path.dirname(SERVER_JS), "..");

export const FOLDERS = [
  { dir: config.HOME_DIR, purpose: "everything this server stores" },
  { dir: config.COURSES_DIR, purpose: "per-course Markdown written by sync" },
  { dir: config.CACHE_DIR, purpose: "normalized JSON cache the tools read" },
  { dir: config.DATA_DIR, purpose: "saved session cookies and sync state" },
  { dir: config.LOGS_DIR, purpose: "logs and login screenshots" },
  { dir: config.DOWNLOAD_DIR, purpose: "attachments fetched by learnus_fetch_url" },
];

export function createFolders(): string[] {
  const created: string[] = [];
  for (const { dir } of FOLDERS) {
    if (!fs.existsSync(dir)) created.push(dir);
    // Private to the user: these hold session cookies and coursework.
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return created;
}

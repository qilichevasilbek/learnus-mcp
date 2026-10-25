import fs from "node:fs";
import * as config from "../learnus/config.js";
import { deleteCredentials } from "../credentials.js";

export async function logoutCommand(): Promise<void> {
  const removed = deleteCredentials();
  const hadSession = fs.existsSync(config.SESSION_FILE);
  fs.rmSync(config.SESSION_FILE, { force: true });
  console.log(removed.length ? `Removed saved credentials from: ${removed.join(", ")}` : "No saved credentials found.");
  console.log(hadSession ? "Removed the saved session." : "No saved session found.");
  console.log(`The cache (${config.HOME_DIR}) was kept; delete that folder to remove coursework data too.`);
}

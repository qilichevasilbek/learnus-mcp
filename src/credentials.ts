/**
 * Where the Yonsei ID and password come from, and how they are stored.
 *
 * Lookup order: environment (`YONSEI_ID` + `YONSEI_PW`) → OS keystore →
 * `credentials.json` under LEARNUS_MCP_HOME. Saving prefers the keystore, so the
 * password is not sitting in an agent's MCP config or in a plain file.
 *
 * Secrets never ride on argv (visible to `ps`): the macOS `security` tool is fed
 * through `security -i` on stdin and `secret-tool` reads its secret from stdin.
 * The stored secret is base64 of a JSON blob, which keeps it printable —
 * `security -w` prints non-ASCII secrets as hex — and holds the ID and password
 * together under one fixed account name.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HOME_DIR } from "./learnus/config.js";

export interface Credentials {
  id: string;
  pw: string;
}

export type CredentialSource =
  | "environment"
  | "macOS Keychain"
  | "Linux keyring (secret-tool)"
  | "credentials file";

const SERVICE = "learnus-mcp";
const ACCOUNT = "default";
export const CREDENTIALS_FILE = path.join(HOME_DIR, "credentials.json");

const encode = (c: Credentials) => Buffer.from(JSON.stringify(c), "utf8").toString("base64");

function decode(b64: string): Credentials | null {
  try {
    const c = JSON.parse(Buffer.from(b64.trim(), "base64").toString("utf8"));
    return typeof c.id === "string" && typeof c.pw === "string" && c.id && c.pw ? c : null;
  } catch {
    return null;
  }
}

function run(cmd: string, args: string[], input?: string) {
  const r = spawnSync(cmd, args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  return { ok: !r.error && r.status === 0, out: r.stdout ?? "" };
}

/** Set LEARNUS_MCP_NO_KEYSTORE=1 to use only the 0600 file (containers, tests). */
const noKeystore = () => process.env.LEARNUS_MCP_NO_KEYSTORE === "1";

/* ------------------------------------------------------------- backends --- */

const keychain = {
  source: "macOS Keychain" as const,
  available: () => process.platform === "darwin" && !noKeystore(),
  read: () => {
    const r = run("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]);
    return r.ok ? decode(r.out) : null;
  },
  write: (c: Credentials) =>
    // Fed on stdin so the password is not in argv; -U updates an existing item.
    run("security", ["-i"], `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w ${encode(c)}\n`).ok,
  remove: () => run("security", ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT]).ok,
};

const secretTool = {
  source: "Linux keyring (secret-tool)" as const,
  available: () => process.platform === "linux" && !noKeystore() && run("secret-tool", ["--version"]).ok,
  read: () => {
    const r = run("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT]);
    return r.ok ? decode(r.out) : null;
  },
  write: (c: Credentials) =>
    run("secret-tool", ["store", `--label=${SERVICE}`, "service", SERVICE, "account", ACCOUNT], encode(c)).ok,
  remove: () => run("secret-tool", ["clear", "service", SERVICE, "account", ACCOUNT]).ok,
};

const file = {
  source: "credentials file" as const,
  available: () => true,
  read: () => {
    try {
      return decode(fs.readFileSync(CREDENTIALS_FILE, "utf8"));
    } catch {
      return null;
    }
  },
  write: (c: Credentials) => {
    try {
      fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(CREDENTIALS_FILE, encode(c), { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  },
  remove: () => {
    try {
      fs.rmSync(CREDENTIALS_FILE);
      return true;
    } catch {
      return false;
    }
  },
};

const backends = [keychain, secretTool, file];

/* ----------------------------------------------------------------- API --- */

export function readCredentials(): (Credentials & { source: CredentialSource }) | null {
  const id = process.env.YONSEI_ID;
  const pw = process.env.YONSEI_PW;
  if (id && pw) return { id, pw, source: "environment" };
  for (const b of backends) {
    if (!b.available()) continue;
    const c = b.read();
    if (c) return { ...c, source: b.source };
  }
  return null;
}

/** Save to the best available store; returns where it landed, or null if nothing worked. */
export function saveCredentials(c: Credentials): CredentialSource | null {
  for (const b of backends) {
    if (!b.available()) continue;
    if (b.write(c)) {
      // Do not leave a stale copy in a lower-priority store.
      for (const other of backends) if (other !== b && other.available()) other.remove();
      return b.source;
    }
  }
  return null;
}

export function deleteCredentials(): CredentialSource[] {
  const removed: CredentialSource[] = [];
  for (const b of backends) if (b.available() && b.read() && b.remove()) removed.push(b.source);
  return removed;
}

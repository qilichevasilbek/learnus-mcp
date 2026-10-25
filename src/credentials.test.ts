import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Must be set before ./learnus/config.js (and so ./credentials.js) is first imported.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "learnus-mcp-test-"));
process.env.LEARNUS_MCP_HOME = home;
process.env.LEARNUS_MCP_NO_KEYSTORE = "1";
delete process.env.YONSEI_ID;
delete process.env.YONSEI_PW;

const { saveCredentials, readCredentials, deleteCredentials, CREDENTIALS_FILE } = await import("./credentials.js");

test("nothing is found before anything is saved", () => {
  assert.equal(readCredentials(), null);
});

test("credentials round-trip through the file store, including non-ASCII and quotes", () => {
  const creds = { id: "2024123456", pw: `pä$$ "w0rd" 비밀 '\\` };
  assert.equal(saveCredentials(creds), "credentials file");
  assert.deepEqual(readCredentials(), { ...creds, source: "credentials file" });
});

test("the credentials file is private to the user", { skip: process.platform === "win32" }, () => {
  assert.equal(fs.statSync(CREDENTIALS_FILE).mode & 0o777, 0o600);
});

test("the environment wins over anything stored", () => {
  process.env.YONSEI_ID = "envid";
  process.env.YONSEI_PW = "envpw";
  assert.deepEqual(readCredentials(), { id: "envid", pw: "envpw", source: "environment" });
  delete process.env.YONSEI_ID;
  delete process.env.YONSEI_PW;
});

test("a half-set environment is ignored rather than mixed with stored values", () => {
  process.env.YONSEI_ID = "onlyid";
  assert.equal(readCredentials()?.source, "credentials file");
  delete process.env.YONSEI_ID;
});

test("logout removes what was saved", () => {
  assert.deepEqual(deleteCredentials(), ["credentials file"]);
  assert.equal(readCredentials(), null);
});

# learnus-mcp

MCP server that gives AI agents access to Yonsei LearnUS (Moodle) and the 전자출결 attendance portal. Extracted from
the Alice assistant's tool layer. TypeScript, ESM, Node 20+, built with plain `tsc` into `dist/`.

## Layout

- `src/server.ts` — entry point and CLI dispatch. No command = stdio MCP server; everything else is a setup command.
- `src/mcp.ts` — the seam to the MCP SDK: `tool(name, description, zodShape, handler)` → `McpServer`.
- `src/learnus/` — the 13 tools (`index.ts`), scrapers, auth, cache, sync. Tools read a local cache; only
  `learnus_sync` (or `refresh: true`) goes live.
- `src/credentials.ts` — env → OS keystore → `0600` file. `src/prompt.ts` — hidden password input.
- `src/commands/` — `setup`, `login`, `logout`, `doctor`, `config`.
- `src/extract/` — HTML → Markdown for `learnus_fetch_url`.
- `examples/claude-skill/SKILL.md` — the skill `setup` installs for Claude.

## Rules that matter

- **stdout is the MCP wire in server mode.** Never `console.log` on the server path; log through `learnus/logger.ts`
  (stderr). CLI commands may print to stdout.
- **Secrets never ride on argv** (visible to `ps`). Feed `security`/`secret-tool` through stdin; never put a password
  in an MCP config the CLI would echo. The stored secret is base64 JSON so `security -w` can't hex-encode it.
- **Credentials are read at login time**, not module load (`readCredentials()` in `learnus/auth.ts`).
- **No course code is hardcoded.** Enrollment is discovered each term. Tool descriptions describe the shape of a
  code, never one term's list.
- **A logged-out LearnUS answers HTTP 200 with its login page.** Detect it (`looksLikeLoginWall`) rather than
  trusting the status code.
- The attendance portal (`ysrollbook`) is authoritative for timetable and attendance; its cookie lapses before LearnUS's.

## Commands

```bash
npm run build && npm test    # unit + MCP protocol + credential tests
npm run doctor               # environment check
```

Tests that touch credentials set `LEARNUS_MCP_HOME` to a temp dir and `LEARNUS_MCP_NO_KEYSTORE=1` so they never
touch a real keychain. Don't run `login` with made-up credentials against the live SSO.

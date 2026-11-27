# learnus-mcp

MCP server that gives AI agents access to Yonsei LearnUS (Moodle), the 전자출결 attendance portal and the Sinchon ⇄
Songdo shuttle bus. Extracted from the Alice assistant's tool layer. TypeScript, ESM, Node 20+, built with plain `tsc` into `dist/`.

## Layout

- `src/server.ts` — entry point and CLI dispatch. No command = stdio MCP server; everything else is a setup command.
- `src/mcp.ts` — the seam to the MCP SDK: `tool(name, description, zodShape, handler)` → `McpServer`.
- `src/learnus/` — the 13 LearnUS + 전자출결 tools (`index.ts`), scrapers, auth, cache, sync. Tools read a local cache; only
  `learnus_sync` (or `refresh: true`) goes live.
- `src/credentials.ts` — env → OS keystore → `0600` file. `src/prompt.ts` — hidden password input.
- `src/commands/` — `setup`, `login`, `logout`, `doctor`, `config`.
- `src/shuttle/` — `shuttle_next` / `shuttle_timetable`. `parse.ts` reads one timetable notice, `board.ts` finds
  notices on yonsei.ac.kr and caches them, `schedule.ts` picks the notice covering a date and computes next departures.
  `src/app.ts` composes these with the LearnUS tools into the one server.
- `src/dorm/` — `seminar_room_*` (Songdo dorm seminar / dance / band rooms on the academic portal, underwood1).
  `wire.ts` builds the portal's eXBuilder6 form bodies, `parse.ts` reads its JSON by field name, `rules.ts` holds the
  page's client-side booking rules, `portal.ts` is the Playwright transport, `service.ts` the four operations over an
  injectable transport. `src/time.ts` has the Seoul clock helpers shared with the shuttle.
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
- **Shuttle notices come in two layouts** (semester: numbered trips, vehicle column; vacation: three trips, no vehicles,
  one time marked `*`) and the period text has quirks (`운행기간 : : 2026. 9. 1.`, `공휴일은 운행 없음`). Pick the notice whose
  *period* covers the date, never just the newest. A row without exactly two times is an error, not a gap. Test against
  the real HTML in `test/fixtures/` — synthetic fixtures hid both quirks.
- "Portal" is ambiguous: `portal_timetable` is the 전자출결 site. The Yonsei Portal (`portal.yonsei.ac.kr`) opens the
  academic system on `underwood1.yonsei.ac.kr`, its own SSO client (`haksaYonsei`) on the same `infra.yonsei.ac.kr`
  SSO as LearnUS; `src/dorm/` reaches it via `SSOLegacy.do?pname=spLogin`. Shuttle seat booking there is **not
  implemented**. Don't write calls for pages that haven't been inspected while signed in.
- **underwood1 answers HTTP 200 when signed out** — JSON `_METADATA_.success:false, msg P000000-0096`, or an HTML page
  alerting "SSO 인증정보가 없습니다" that then navigates to `SSOLegacy.do?pname=spLogout` (blocked in `portal.ts`: it
  would end the SSO session LearnUS uses too). Every call carries `_menuId`/`_pgmId` derived from the menu's ids; wrong
  ids give `P000000-0020`.
- **Seminar-room writes are gated.** `seminar_room_book`/`_cancel` do nothing but preview without `confirm: true`;
  writes are sent once (no retry) and reported from a fresh read of the reservation list. Only Songdo (`sdom`,
  program sdombk0200) is implemented; Sinchon (`ndom`, ndomap2400) is a different program that hasn't been inspected.
- The attendance portal (`ysrollbook`) is authoritative for timetable and attendance; its cookie lapses before LearnUS's.

## Commands

```bash
npm run build && npm test    # unit + MCP protocol + credential tests
npm run doctor               # environment check
```

Tests that touch credentials set `LEARNUS_MCP_HOME` to a temp dir and `LEARNUS_MCP_NO_KEYSTORE=1` so they never
touch a real keychain. Don't run `login` with made-up credentials against the live SSO.

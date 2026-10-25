# learnus-mcp

Give your AI agent real access to your Yonsei coursework. This is an [MCP](https://modelcontextprotocol.io) server
for **LearnUS** and the **전자출결** attendance portal, extracted from the tool layer of the Alice assistant, so
Claude Code, Claude Desktop, Cline, Codex and Cursor can all use it.

> *"What's due this week?"* · *"How am I doing in my courses?"* · *"Can I skip tomorrow's class?"*

## Quick start

You need [Node.js 20+](https://nodejs.org) and a Yonsei account.

```bash
git clone https://github.com/qilichevasilbek/learnus-mcp.git
cd learnus-mcp
./scripts/setup.sh
```

On Windows: `npm install && npm run build && npm run setup`.

The guided setup creates the folders, installs the scraper's browser, signs you in, connects Claude Code, installs
the Claude skill and fills the cache. It asks before each step. Afterwards, restart Claude and ask a question.

Something not working? `npm run doctor` checks everything and prints the fix for each problem.

## Links

| | |
|---|---|
| LearnUS | https://ys.learnus.org |
| Attendance & timetable (전자출결) | https://ysrollbook.yonsei.ac.kr |
| Yonsei SSO | https://infra.yonsei.ac.kr |

## Signing in

Pick one in setup, or run it any time:

| | Command | What happens |
|---|---|---|
| **Save ID + password** *(recommended)* | `npm run login` | You type them (the password is hidden). They are checked against the real SSO, then saved to the **macOS Keychain** or **Linux keyring**, or a `0600` file if neither exists. The session renews itself, so the cache can refresh unattended. |
| **Sign in by hand** | `npm run login -- --browser` | A browser window opens on LearnUS. You sign in yourself (2FA, captcha, anything) and it is detected automatically. No password is stored; the session lasts about 4 hours. |
| **Forget everything** | `node dist/server.js logout` | Removes saved credentials and the session. |

Credentials are looked up in this order: environment (`YONSEI_ID` + `YONSEI_PW`) → OS keystore → `0600` file. Use
the environment for servers and containers with no keystore. The password is never written into an agent's config.

## Connect your agent

Setup registers Claude Code for you. For anything else, `node dist/server.js config` prints snippets with your real
paths. Step-by-step Claude instructions, including the skill that teaches Claude how to use the tools, are in
**[docs/CLAUDE_SETUP.md](docs/CLAUDE_SETUP.md)**.

```bash
claude mcp add learnus --scope user -- node /absolute/path/to/learnus-mcp/dist/server.js
```

## Folders

Everything lives under one directory, `~/.learnus-mcp` (change with `LEARNUS_MCP_HOME`), created `0700`:

| Folder | Contents |
|---|---|
| `courses/<CODE>/` | Per-course Markdown written by sync: announcements, materials, syllabus text |
| `courses/data/` | Normalized JSON cache the tools read |
| `state/` | Saved session cookies, the sync record, course map |
| `logs/` | Logs and login screenshots |
| `downloads/` | Attachments fetched by `learnus_fetch_url` |

## Commands

| Command | Does |
|---|---|
| `npm run setup` | Guided first-time setup |
| `npm run login` | Save credentials (`--browser` to sign in by hand, `--no-verify` to skip the SSO check) |
| `node dist/server.js logout` | Forget credentials and session |
| `npm run sync` | Refresh the cache now (`--rediscover`, `--no-syllabus`, `--semester 20262`) |
| `npm run doctor` | Check the installation |
| `node dist/server.js config` | Print agent configuration snippets |
| `node dist/server.js` | Run as an MCP server over stdio (what agents launch) |

To keep the cache fresh, schedule a sync, e.g. cron: `0 */4 * * * cd /path/to/learnus-mcp && node dist/server.js sync`.

## Tools

| Tool | What it answers |
|------|-----------------|
| `learnus_sync` | Full refresh of everything below into the local cache (60–120 s) |
| `learnus_last_run` | When the cache was last refreshed and which sources succeeded |
| `learnus_courses` | Enrolled courses this term |
| `learnus_announcements` / `learnus_fetch_announcement` | Course announcements, and one in full |
| `learnus_assignments` | Assignments, quizzes and Turnitin papers with deadlines and submission state |
| `learnus_materials` | Lecture files and readings, including links instructors post in section text |
| `learnus_calendar` | The LearnUS month calendar (past and future) |
| `learnus_grades` | Recorded marks, weights and instructor feedback |
| `learnus_syllabus` | Syllabus / schedule documents as text |
| `learnus_attendance` / `portal_timetable` | Official attendance and timetable from the 전자출결 portal |
| `learnus_fetch_url` | Any page or file on a Yonsei host, as Markdown or extracted text |

**Cache-first.** `learnus_sync` does one authenticated pass; every other tool reads the cache in about a millisecond
and only goes live with `refresh: true`. No course codes are hardcoded: enrollment is discovered each term.

## Troubleshooting

- **"Yonsei rejected that login"** — check the ID and password by signing in at https://ys.learnus.org, or use
  `npm run login -- --browser`. Nothing is saved on failure.
- **Timetable or attendance look empty** — the attendance portal drops its session before LearnUS does. Run
  `npm run sync`, then check `learnus_last_run` for which source failed.
- **A tool says the session expired** — with saved credentials it renews itself; otherwise run `npm run login` again.
- **Linux, no keyring** — install `libsecret-tools` for `secret-tool`, otherwise a `0600` file is used.
  `LEARNUS_MCP_NO_KEYSTORE=1` forces the file.
- **Tools don't appear in Claude** — restart it, then `claude mcp list` (Claude Code) and `npm run doctor`.

## Security & scope

- Your password goes to the OS keystore (or a `0600` file), never to an MCP config, argv or this repo. Session
  cookies are `0600`. `learnus_fetch_url` only sends the Yonsei session to Yonsei hosts.
- This scrapes pages that have no public API and can break when LearnUS changes. Use it on your own account only.
- Login screenshots in `logs/` can show personal information; they stay on your machine.

## Development

```bash
npm test      # builds, then runs unit, MCP-protocol and credential tests
```

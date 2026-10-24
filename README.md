# learnus-mcp

An [MCP](https://modelcontextprotocol.io) server that gives AI agents real access to a Yonsei student's coursework:
**LearnUS** (Moodle) and the **전자출결** attendance portal. Extracted from the tool layer of
Alice, so any MCP-capable agent — Claude Code, Claude Desktop, Cline, Codex,
Cursor — can use it.

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

**Cache-first.** `learnus_sync` does one authenticated pass and writes normalized JSON and per-course Markdown; every
other tool reads that cache in about a millisecond and only goes live on `refresh: true`. No course codes are
hardcoded — enrollment is discovered each term.

## Setup

```bash
git clone <this repo> && cd learnus-mcp
npm install
npx playwright install chromium   # the scraper drives a headless browser
npm run build
```

Credentials are read from the environment (never from a file in this repo):

| Variable | Purpose |
|----------|---------|
| `YONSEI_ID`, `YONSEI_PW` | Yonsei SSO login |
| `YONSEI_SEMESTER` | Optional, e.g. `20262`; otherwise derived from the date |
| `LEARNUS_MCP_HOME` | Optional; where cache, session cookies, logs and downloads live (default `~/.learnus-mcp`) |

### Claude Code

```bash
claude mcp add learnus -e YONSEI_ID=... -e YONSEI_PW=... -- node /absolute/path/to/learnus-mcp/dist/server.js
```

### Claude Desktop / Cline / Cursor (JSON config)

```json
{
  "mcpServers": {
    "learnus": {
      "command": "node",
      "args": ["/absolute/path/to/learnus-mcp/dist/server.js"],
      "env": { "YONSEI_ID": "your-id", "YONSEI_PW": "your-password" }
    }
  }
}
```

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.learnus]
command = "node"
args = ["/absolute/path/to/learnus-mcp/dist/server.js"]
env = { YONSEI_ID = "your-id", YONSEI_PW = "your-password" }
```

## Keeping the cache fresh

Run a sync on a schedule so agents can answer from the cache:

```bash
node dist/server.js sync [--rediscover] [--no-syllabus] [--semester 20262]
```

Exits non-zero only on a fatal failure; a partial sync (one source down) still succeeds and says which source failed.

## Notes

- **Security.** Your SSO password lives in the agent's MCP config; the cached session cookies are written `0600`
  under `LEARNUS_MCP_HOME`. `learnus_fetch_url` only sends that session to Yonsei hosts.
- **Session expiry.** A logged-out LearnUS answers HTTP 200 with its login page. The tools detect this and report an
  expired session rather than returning the login form as if it were content. The portal drops its cookie before
  LearnUS does, so check `learnus_last_run` if timetable or attendance look empty.
- **Unofficial.** This scrapes pages that have no public API and may break when LearnUS changes. Use it for your own
  account only.

## Development

```bash
npm test      # builds, then runs the unit and MCP-protocol tests
```

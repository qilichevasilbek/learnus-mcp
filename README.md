# learnus-mcp

Give your AI agent real access to your Yonsei life. This is an [MCP](https://modelcontextprotocol.io) server for
**LearnUS**, the **전자출결** attendance portal, the **Sinchon ⇄ Songdo shuttle bus** and **Songdo dormitory seminar
rooms**, extracted from the tool layer
of the Alice assistant, so Claude Code, Claude Desktop, Cline, Codex and Cursor can all use it.

> *"What's due this week?"* · *"How am I doing in my courses?"* · *"Can I skip tomorrow's class?"* ·
> *"When's the next shuttle to Songdo?"* · *"Book a seminar room in the dorm tomorrow at 7pm."*

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
| Shuttle timetable notices | https://www.yonsei.ac.kr/bbs/sc/58/artclList.do |
| Shuttle seat reservation | https://portal.yonsei.ac.kr → IT서비스 → 국제캠퍼스 셔틀버스 예약 |
| Dorm seminar-room booking | https://portal.yonsei.ac.kr → 학사정보시스템 → 기숙사 → 세미나실, 댄스/밴드연습실 예약 |

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
| `shuttle_next` | When the next Sinchon ⇄ Songdo shuttle leaves, in Seoul time, skipping weekends |
| `shuttle_timetable` | The full timetable for a date — the semester or vacation notice whose period covers it |
| `seminar_room_availability` | Free and taken hours of the Songdo dorm seminar rooms and dance/band rooms, for a date or several days |
| `seminar_room_my_reservations` | Your seminar-room reservations: date, room, hours, status (applied / approved / cancelled / rejected) |
| `seminar_room_book` | Book a room — previews unless called with `confirm: true` |
| `seminar_room_cancel` | Cancel a reservation — previews unless called with `confirm: true` |

**Cache-first.** `learnus_sync` does one authenticated pass; every other tool reads the cache in about a millisecond
and only goes live with `refresh: true`. No course codes are hardcoded: enrollment is discovered each term.

**The shuttle tools need no login, no browser and no credentials.** They read Yonsei's own timetable notices on
yonsei.ac.kr, choose the one whose stated service period covers the date (the vacation timetable is posted days before
the semester one ends), and cite it in every answer. They cannot see public holidays, they do not book seats (that is on
the Yonsei Portal, behind your login), and when no timetable covers a date they say so rather than guess. If Yonsei is
unreachable they serve their last cached copy, labelled as stale.

## Dorm seminar rooms

For residents of the **Songdo (International Campus) dormitory**: the seminar rooms and dance/band practice rooms of
송도1학사 and 송도2학사, as booked on the Yonsei Portal (학사정보시스템 → 기숙사 → 세미나실, 댄스/밴드연습실 예약).
These tools are live, not cached: they sign in with the same Yonsei login as the LearnUS tools and use the portal's own
endpoints.

**Booking and cancelling ask first.** `seminar_room_book` and `seminar_room_cancel` take `confirm`. Without
`confirm: true` they check everything against the live page and return a preview — nothing is sent. The agent is told
to show you that preview and wait for your yes. After a real submit, the answer is what the portal's reservation list
then shows, not what the request said it would do.

Rules, as the reservation page applies them:

- no same-day booking; at most **5 days ahead**
- one-hour slots (HH:00–HH:50) within the room's hours (09:00–24:00 for every room seen)
- at most **4 hours** per booking, and no more people than the room holds (8, 10 or 15)
- event name, group name, event kind (lecture, exam, camp, meeting, seminar, other) and the number of people are required
- a reservation can be cancelled until its date; rooms seen so far are approved immediately (승인)

These come from the page's own script; whether the server checks them too was not tested, so the tool enforces them
itself. Any further limit the portal has is passed on in its own words. The **Sinchon dormitories** (기숙사(신촌) →
세미나실예약) are a separate page and are **not supported**.

## Troubleshooting

- **"Yonsei rejected that login"** — check the ID and password by signing in at https://ys.learnus.org, or use
  `npm run login -- --browser`. Nothing is saved on failure.
- **Timetable or attendance look empty** — the attendance portal drops its session before LearnUS does. Run
  `npm run sync`, then check `learnus_last_run` for which source failed.
- **A tool says the session expired** — with saved credentials it renews itself; otherwise run `npm run login` again.
- **Linux, no keyring** — install `libsecret-tools` for `secret-tool`, otherwise a `0600` file is used.
  `LEARNUS_MCP_NO_KEYSTORE=1` forces the file.
- **"No published shuttle timetable covers …"** — Yonsei hasn't posted the next semester or vacation timetable yet.
  The tool names the latest one it found; check the board linked above.
- **"may not book Songdo dormitory rooms"** — the portal only lets current Songdo dormitory residents book; the page
  itself shows "신청가능 대상자가 아닙니다".
- **Tools don't appear in Claude** — restart it, then `claude mcp list` (Claude Code) and `npm run doctor`.

## Security & scope

- Your password goes to the OS keystore (or a `0600` file), never to an MCP config, argv or this repo. Session
  cookies are `0600`. `learnus_fetch_url` only sends the Yonsei session to Yonsei hosts.
- The shuttle tools only read public pages on yonsei.ac.kr.
- The seminar-room tools send your Yonsei session only to `underwood1.yonsei.ac.kr`. Booking needs your student
  number in the request; it is read from the portal at run time and never logged or shown.
- This scrapes pages that have no public API and can break when LearnUS changes. Use it on your own account only.
- Login screenshots in `logs/` can show personal information; they stay on your machine.

## Development

```bash
npm test      # builds, then runs unit, MCP-protocol and credential tests
```

## License

[MIT](LICENSE)

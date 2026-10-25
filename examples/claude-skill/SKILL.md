---
name: learnus
description: Answer questions about the user's Yonsei coursework — deadlines, assignments, grades, attendance, timetable, announcements, readings, syllabus — using the learnus MCP tools. Use whenever the user asks what is due, how they are doing, whether they can skip a class, or what an instructor posted.
---

# Using the learnus tools

The `learnus` MCP server reads the user's real LearnUS and 전자출결 data. Tools are named `learnus_*` and `portal_timetable`.

## How to work

1. **Read the cache; don't scrape per question.** Every tool answers from a local cache in about a millisecond. Call `learnus_last_run` first to see how old it is and which sources succeeded.
2. **Refresh only when needed.** Call `learnus_sync` (60–120 s) if the cache is more than a few hours old, a source failed, or the user asks for "latest". Pass `refresh: true` on a single tool for one live fetch.
3. **Pick the right source.**
   - Deadlines: `learnus_assignments` *and* `learnus_calendar`. Neither is a superset of the other; check both before saying something has no deadline.
   - "How am I doing": `learnus_grades`. The gradebook weights are what is enforced, even when the syllabus says otherwise.
   - Attendance and the official timetable: `learnus_attendance` and `portal_timetable` — the 전자출결 portal is authoritative, not LearnUS.
   - Readings: `learnus_materials` includes links instructors paste into section text, not just uploaded files.
   - A specific page or attachment on a Yonsei host: `learnus_fetch_url`.
4. **Never claim something does not exist** until you have checked the relevant tools and `learnus_last_run` shows that source synced. Absence from a failed or stale sync is not absence from LearnUS.
5. **Course codes are discovered each term.** Don't assume a list; call `learnus_courses`.

## When a tool reports an expired session

The user must sign in again: tell them to run `node <path-to-learnus-mcp>/dist/server.js login` (or `login --browser`). Don't retry in a loop.

## Privacy

This is the user's own academic record. Don't paste grades or attendance anywhere except the conversation.

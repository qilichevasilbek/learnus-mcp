---
name: learnus
description: Answer questions about the user's Yonsei coursework and commute — deadlines, assignments, grades, attendance, timetable, announcements, readings, syllabus, the Sinchon–Songdo shuttle bus and Songdo dorm seminar rooms — using the learnus MCP tools. Use whenever the user asks what is due, how they are doing, whether they can skip a class, what an instructor posted, when the next shuttle leaves, or wants to find, book or cancel a dorm seminar room.
---

# Using the learnus tools

The `learnus` MCP server reads the user's real LearnUS and 전자출결 data. Tools are named `learnus_*`, `portal_timetable`, `shuttle_*` and `seminar_room_*`.

## How to work

1. **Read the cache; don't scrape per question.** Every tool answers from a local cache in about a millisecond. Call `learnus_last_run` first to see how old it is and which sources succeeded.
2. **Refresh only when needed.** Call `learnus_sync` (60–120 s) if the cache is more than a few hours old, a source failed, or the user asks for "latest". Pass `refresh: true` on a single tool for one live fetch.
3. **Pick the right source.**
   - Deadlines: `learnus_assignments` *and* `learnus_calendar`. Neither is a superset of the other; check both before saying something has no deadline.
   - "How am I doing": `learnus_grades`. The gradebook weights are what is enforced, even when the syllabus says otherwise.
   - Attendance and the official timetable: `learnus_attendance` and `portal_timetable` — the 전자출결 portal is authoritative, not LearnUS.
   - Readings: `learnus_materials` includes links instructors paste into section text, not just uploaded files.
   - A specific page or attachment on a Yonsei host: `learnus_fetch_url`.
   - The inter-campus shuttle: `shuttle_next` for "when can I leave" and `shuttle_timetable` for a whole day. These read
     Yonsei's public notices (no login, no sync). Say which notice and period the answer came from, remind the user that
     seats are reserved on the Yonsei Portal and that public holidays aren't checked, and if no timetable covers the date
     say it isn't posted yet instead of guessing. You cannot book seats.
   - Songdo dorm seminar / dance / band rooms: `seminar_room_availability` to find a room, `seminar_room_my_reservations`
     for what is booked. These are live (no sync) and only for Songdo dormitory residents.
4. **Booking and cancelling are the user's decision.** Call `seminar_room_book` / `seminar_room_cancel` without
   `confirm` first, show the user the preview word for word (room, date, time), and only call again with
   `confirm: true` after they say yes in their own words. Never confirm on your own, never book "just to hold" a slot,
   and report what the tool says the portal now shows. No same-day bookings; at most 5 days ahead and 4 hours.
5. **Never claim something does not exist** until you have checked the relevant tools and `learnus_last_run` shows that source synced. Absence from a failed or stale sync is not absence from LearnUS.
6. **Course codes are discovered each term.** Don't assume a list; call `learnus_courses`.

## When a tool reports an expired session

The user must sign in again: tell them to run `node <path-to-learnus-mcp>/dist/server.js login` (or `login --browser`). Don't retry in a loop.

## Privacy

This is the user's own academic record. Don't paste grades or attendance anywhere except the conversation.

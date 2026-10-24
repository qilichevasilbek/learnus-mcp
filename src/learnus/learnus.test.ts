import test from "node:test";
import assert from "node:assert/strict";
import { currentSemester } from "./config.js";
import { assessRisk, parseMeetings, periodNotation } from "./rollbook.js";
import { parseCourseNo } from "./scrapers/courses.js";
import {
  buildAssignments,
  classifyModname,
  normalizeDueDate,
  parseTurnitinParts,
  summarizeTurnitinSubmissions,
  turnitinPartName,
} from "./scrapers/assignments.js";
import {
  buildMaterials,
  classifyMaterialType,
  isLearnusUrl,
} from "./scrapers/materials.js";
import { normalizeItemName } from "./output.js";
import { assertAllowedHost, filenameFromDisposition, looksLikeLoginWall } from "./fetch-single.js";

test("semester rollover treats January and February as prior fall", () => {
  assert.equal(currentSemester(new Date("2026-01-15T12:00:00Z")), "20252");
  assert.equal(currentSemester(new Date("2026-03-15T12:00:00Z")), "20261");
  assert.equal(currentSemester(new Date("2026-09-15T12:00:00Z")), "20262");
});

test("course and meeting parsers preserve the official section", () => {
  assert.deepEqual(parseCourseNo("CRITICAL REASONING (UIC2101.08-00)"), {
    code: "UIC2101",
    division: "08",
    courseNo: "UIC2101-08-00",
  });
  const meetings = parseMeetings("수 09:00 - 09:50  금 09:00 - 10:50");
  assert.deepEqual(meetings.map((meeting) => meeting.periods), [[1], [1, 2]]);
  assert.equal(periodNotation(meetings), "수1, 금1,2");
});

test("attendance risk applies three-lates-as-one-absence", () => {
  const risk = assessRisk({
    courseNo: "UIC2101-08-00",
    code: "UIC2101",
    division: "08",
    title: "Critical Reasoning",
    present: 3,
    late: 3,
    absent: 1,
    earlyLeave: 0,
    heldSessions: 7,
    plannedSessions: 12,
    sessions: [],
  });
  assert.equal(risk.failThreshold, 4);
  assert.equal(risk.level, "watch");
});

/* ------------------------------------------------------------------------- *
 * Regression tests for the 2026-09-22 LMS fixes.
 *
 * Every literal below is real markup measured live against production LearnUS,
 * so these pin the parsers to what the LMS actually serves rather than to what
 * it was assumed to serve.
 * ------------------------------------------------------------------------- */

test("Turnitin papers are recognised as assignments", () => {
  assert.equal(classifyModname("https://ys.learnus.org/mod/assign/view.php?id=1"), "assign");
  assert.equal(classifyModname("https://ys.learnus.org/mod/quiz/view.php?id=2"), "quiz");
  // The bug: this returned "assign" only because turnitin never matched the
  // selector at all, so every Turnitin paper was invisible to learnus_assignments.
  assert.equal(
    classifyModname("https://ys.learnus.org/mod/turnitintooltwo/view.php?id=4514105"),
    "turnitintooltwo"
  );
  assert.equal(classifyModname("https://ys.learnus.org/mod/vod/view.php?id=3"), null);
});

test("rendered due dates normalise to the shape toInstant understands", () => {
  assert.equal(normalizeDueDate("21 Sep 2026 - 16:50"), "2026-09-21 16:50");
  assert.equal(normalizeDueDate("1 Oct 2026 - 17:00"), "2026-10-01 17:00");
  assert.equal(normalizeDueDate("16 Dec 2026 - 10:00"), "2026-12-16 10:00");
  assert.equal(normalizeDueDate("2026-09-26 00:00"), "2026-09-26 00:00");
  assert.equal(normalizeDueDate("\u2014"), null);
  assert.equal(normalizeDueDate(null), null);
});

test("a Turnitin part table yields one deadline per part, ignoring the prose row", () => {
  // Row 2 is verbatim from UIC1581's In-Class Essay #1: the professor's prompt
  // rendered as a single-cell row inside the same table. Iterating rows naively
  // turns that essay question into an assignment with no date.
  const parts = parseTurnitinParts([
    ["In-Class Essay #1 - Part 1", "21 Sep 2026 - 13:45", "21 Sep 2026 - 16:50", "01 Oct 2026 - 17:00", "10"],
    ["The teaching team will announce the topic on this page at 4pm. For other instructions, see the syllabus."],
  ]);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].title, "In-Class Essay #1 - Part 1");
  assert.equal(parts[0].due, "2026-09-21 16:50");

  const multi = parseTurnitinParts([
    ["Paper - Part 1", "13 Aug 2026 - 12:28", "30 Sep 2026 - 21:00", "20 Aug 2026 - 12:28", "100"],
    ["Paper - Part 2", "01 Oct 2026 - 00:00", "21 Oct 2026 - 10:00", "28 Oct 2026 - 10:00", "100"],
  ]);
  assert.deepEqual(multi.map((p) => p.due), ["2026-09-30 21:00", "2026-10-21 10:00"]);

  assert.deepEqual(parseTurnitinParts([["No records to display."]]), []);
});

test("part names match the calendar so upcoming-summary collapses them", () => {
  assert.equal(
    turnitinPartName("In-Class Essay #1", "In-Class Essay #1 - Part 1"),
    "In-Class Essay #1 - Part 1"
  );
  // Moodle's anchor text carries a theme suffix the calendar never uses. Joining
  // the two produced "In-class Essay #2 Assignment(TurnItIn) - In-class Essay #2
  // - Part 1", which listed every Turnitin deadline twice in upcoming-summary.
  assert.equal(
    turnitinPartName("In-class Essay #2 Assignment(TurnItIn)", "In-class Essay #2 - Part 1"),
    "In-class Essay #2 - Part 1"
  );
  assert.equal(turnitinPartName("Midterm Paper", "Part 1"), "Midterm Paper - Part 1");
  assert.equal(turnitinPartName("Final Paper", ""), "Final Paper");
  // The dedupe contract with learnus_calendar: suffix wording and dash variants
  // must produce the same key, or every Turnitin deadline is listed twice.
  assert.equal(
    normalizeItemName("In-Class Essay #1 - Part 1 is due"),
    normalizeItemName("In-Class Essay #1 \u2013 Part 1")
  );
});

test("Turnitin submission tables read as submitted or not", () => {
  assert.equal(summarizeTurnitinSubmissions([["No records to display."]]), "Not submitted");
  assert.equal(summarizeTurnitinSubmissions([]), "Not submitted");
  assert.equal(
    summarizeTurnitinSubmissions([["Essay.docx", "22 Sep 2026 - 10:00", "12%"]]),
    "Submitted (1)"
  );
});

test("repeated anchors for one activity collapse, keeping the richest fields", () => {
  const items = buildAssignments([
    { href: "https://ys.learnus.org/mod/turnitintooltwo/view.php?id=4514105", text: "", section: "Week 3" },
    { href: "https://ys.learnus.org/mod/turnitintooltwo/view.php?id=4514105#p1", text: "In-Class Essay #1", section: "" },
    { href: "https://ys.learnus.org/mod/vod/view.php?id=9", text: "Lecture 3", section: "Week 3" },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, "In-Class Essay #1");
  assert.equal(items[0].modname, "turnitintooltwo");
  // The icon anchor knew the section; the titled anchor did not.
  assert.equal(items[0].section, "Week 3");
});

test("section-description links become materials without shadowing modules", () => {
  // UIC1581 posts its entire semester of readings as Drive links in the weekly
  // section text and zero files as modules. Missing these is what produced the
  // "the readings are not on LearnUS" answer on 2026-09-20.
  const items = buildMaterials(
    [{ href: "https://ys.learnus.org/mod/resource/view.php?id=77", text: "Week 1 slides", section: "Week 1" }],
    [
      { href: "https://ys.learnus.org/mod/resource/view.php?id=77&forceview=1", text: "Week 1 slides", section: "Week 1" },
      { href: "https://drive.google.com/file/d/abc/view", text: "Rokeya Hossain, Sultana's Dream", section: "Week 1" },
      { href: "#top", text: "back to top", section: "Week 1" },
      { href: "https://drive.google.com/file/d/abc/view", text: "Rokeya Hossain, Sultana's Dream", section: "Week 9" },
    ]
  );

  assert.deepEqual(
    items.map((m) => [m.type, m.source, m.external === true, m.section]),
    [
      ["resource", "module", false, "Week 1"],
      ["link", "section-summary", true, "Week 1"],
      ["link", "section-summary", true, "Week 9"],
    ]
  );
  assert.equal(isLearnusUrl("https://drive.google.com/file/d/abc/view"), false);
  assert.equal(isLearnusUrl("https://ys.learnus.org/course/view.php?id=1"), true);
  assert.equal(classifyMaterialType("https://ys.learnus.org/mod/vod/view.php?id=5"), "vod");
});

test("a login page is never mistaken for content", () => {
  // Measured: an unauthenticated fetch of a real course file returns HTTP 200
  // with the login page. Only the body and the final URL reveal it.
  assert.equal(looksLikeLoginWall("https://ys.learnus.org/login.php", ""), true);
  assert.equal(
    looksLikeLoginWall("https://ys.learnus.org/course/view.php?id=1", '<input id="loginId">'),
    true
  );
  assert.equal(looksLikeLoginWall("https://ys.learnus.org/passni/sso/spLogin2.php", ""), true);
  assert.equal(
    looksLikeLoginWall("https://ys.learnus.org/mod/assign/view.php?id=1", "<h2>Assignment</h2>"),
    false
  );
});

test("only Yonsei hosts are fetched with the Yonsei session", () => {
  assert.equal(
    assertAllowedHost("https://ys.learnus.org/mod/turnitintooltwo/view.php?id=1").hostname,
    "ys.learnus.org"
  );
  assert.equal(
    assertAllowedHost("https://ysrollbook.yonsei.ac.kr/eams/student/main").hostname,
    "ysrollbook.yonsei.ac.kr"
  );
  assert.throws(() => assertAllowedHost("https://drive.google.com/file/d/abc/view"), /not a Yonsei host/);
  assert.throws(() => assertAllowedHost("not a url"), /Not a valid URL/);
});

test("attachment filenames survive both Content-Disposition forms", () => {
  assert.equal(
    filenameFromDisposition('attachment; filename="12_UIC1101_Freshmen Writing Intensive Seminar.docx"'),
    "12_UIC1101_Freshmen Writing Intensive Seminar.docx"
  );
  assert.equal(
    filenameFromDisposition("attachment; filename*=UTF-8''%EA%B0%95%EC%9D%98%EA%B3%84%ED%9A%8D.pdf"),
    "\uac15\uc758\uacc4\ud68d.pdf"
  );
  assert.equal(filenameFromDisposition(undefined), null);
});

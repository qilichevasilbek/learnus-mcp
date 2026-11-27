import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Before the first import of ./learnus/config.js, so the cache lands in a temp dir.
process.env.LEARNUS_MCP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "learnus-mcp-shuttle-"));

const { parseNotice, ShuttleParseError } = await import("./parse.js");
const { parseList } = await import("./board.js");
const { nextDepartures, timetableFor, parseAt, seoulTime, isWeekend } = await import("./schedule.js");
const { shuttleTools } = await import("./index.js");

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../test/fixtures");
const fixture = (name: string) => fs.readFileSync(path.join(fixtures, name), "utf8");
const SEMESTER = fixture("shuttle-notice-2026-2.html");
const WINTER = fixture("shuttle-notice-2025-winter.html");
const LIST = fixture("shuttle-list.html");
const meta = { id: "943967", title: "2026학년도 2학기 국제캠퍼스 셔틀버스 운행 시간표", url: "https://example.test/n", postedDate: "2026-08-27" };

/** A minimal notice in the real layout, for dates the fixtures don't cover. */
const synthetic = (period: string, trips: Array<[string, string]>) =>
  `<div class="view viewCont"><p>운행기간 : ${period}</p><table>
   <tr><td>번호</td><td>시간</td><td>차량</td><td>시간</td><td>차량</td></tr>
   ${trips.map(([a, b], i) => `<tr><td>${i + 1}</td><td>${a}</td><td>버스 1 호</td><td>${b}</td><td>버스 2 호</td></tr>`).join("")}
   </table></div>`;

const NOTICES: Record<string, string> = {
  "943967": SEMESTER,
  "943494": synthetic("2026. 6. 23.(화) ~ 2026. 8. 31.(월)", [["8:00", "8:10"]]),
  "942657": synthetic("2026. 3. 2.(월) ~ 2026. 6. 22.(월)", [["8:00", "8:10"]]),
  "942183": WINTER,
};

function stubFetch(overrides: Record<string, string | number> = {}) {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    calls.push(url);
    const id = url.match(/\/(\d+)\/artclView\.do/)?.[1];
    const body = id ? (overrides[id] ?? NOTICES[id]) : (overrides.list ?? LIST);
    if (body === undefined || typeof body === "number") return new Response("nope", { status: typeof body === "number" ? body : 404 });
    return new Response(String(body), { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
}

/* --------------------------------------------------------------- parser --- */

test("the real 2026-2 notice yields 24 departures per direction", () => {
  const t = parseNotice(SEMESTER, meta);
  assert.equal(t.fromSinchon.length, 24);
  assert.equal(t.fromSongdo.length, 24);
  assert.equal(t.fromSinchon[0].time, "07:00");
  assert.equal(t.fromSinchon.at(-1)!.time, "22:50");
  assert.equal(t.fromSongdo[0].time, "07:00");
  assert.equal(t.fromSongdo.at(-1)!.time, "20:50");
  assert.equal(t.fromSinchon[0].vehicle, "버스1호");
});

test("the notice's service period, rules and route are read", () => {
  const t = parseNotice(SEMESTER, meta);
  assert.equal(t.periodStart, "2026-09-01");
  assert.equal(t.periodEnd, "2026-12-21");
  assert.equal(t.noWeekendOrHolidayService, true);
  assert.match(t.routeFromSinchon ?? "", /백양누리 교통광장.*국제캠퍼스/);
  assert.match(t.routeFromSongdo ?? "", /국제캠퍼스.*신촌캠퍼스/);
  assert.match(t.via ?? "", /영종대교/);
});

test("accessible vehicles are flagged", () => {
  const t = parseNotice(SEMESTER, meta);
  const dep = t.fromSinchon.find((d) => d.time === "07:20")!;
  assert.equal(dep.vehicle, "장애인2호");
  assert.equal(dep.accessible, true);
  assert.equal(t.fromSinchon[0].accessible, false);
});

test("the winter notice parses with its own period", () => {
  const t = parseNotice(WINTER, { ...meta, id: "942183" });
  assert.equal(t.periodStart, "2025-12-22");
  assert.equal(t.periodEnd, "2026-02-27");
  // The vacation layout: three trips, no vehicle column, one time marked with an asterisk.
  assert.deepEqual(t.fromSinchon.map((d) => d.time), ["07:30", "11:00", "17:30"]);
  assert.deepEqual(t.fromSongdo.map((d) => d.time), ["07:30", "12:30", "17:30"]);
  assert.equal(t.fromSinchon[0].vehicle, null);
  assert.equal(t.fromSongdo[2].marked, true, "*17:30 keeps its mark");
  assert.equal(t.fromSongdo[2].time, "17:30", "and the asterisk does not leak into the time");
  assert.equal(t.fromSinchon[2].marked, false);
  assert.equal(t.noWeekendOrHolidayService, true);
  assert.match(t.routeFromSongdo ?? "", /승차 → 총장공관 앞 하차 → 백양로 삼거리 하차 → 신촌캠퍼스 \(백양누리 교통광장\) 하차/, "-> becomes →, spacing inside brackets tidied");
  assert.match(t.via ?? "", /영종대교 · 인천대교/);
});

test("a trip row that loses a time is an error, not a silent gap", () => {
  const broken = SEMESTER.replace(/>8:30</, "><");
  assert.throws(() => parseNotice(broken, meta), (e: unknown) => e instanceof ShuttleParseError && /departure time\(s\) instead of 2/.test(String(e)));
});

test("a notice with no service period cannot be dated, so it fails", () => {
  const html = synthetic("", [["8:00", "8:10"]]); // the label is there, the dates are not
  assert.throws(() => parseNotice(html, meta), (e: unknown) => e instanceof ShuttleParseError && /no service period/.test(String(e)));
});

test("a page without the notice body fails loudly", () => {
  assert.throws(() => parseNotice("<html><body>moved</body></html>", meta), /layout may have changed/);
});

/* ---------------------------------------------------------------- board --- */

test("the board list keeps timetable notices and drops look-alikes", () => {
  const refs = parseList(LIST);
  assert.equal(refs.length, 10);
  assert.ok(refs.every((r) => /국제캠퍼스 셔틀버스 운행 시간표/.test(r.title)));
  assert.ok(!refs.some((r) => /경복궁|PHP/.test(r.title)), "the Sinchon on-campus shuttle is a different service");
  const cur = refs.find((r) => r.id === "943967")!;
  assert.equal(cur.title, "2026학년도 2학기 국제캠퍼스 셔틀버스 운행 시간표");
  assert.equal(cur.postedDate, "2026-08-27");
  assert.equal(cur.url, "https://www.yonsei.ac.kr/bbs/sc/58/943967/artclView.do");
});

/* ------------------------------------------------------------- schedule --- */

test("Seoul time is independent of the machine's zone", () => {
  const d = parseAt("2026-11-27T09:14");
  assert.deepEqual(seoulTime(d), { date: "2026-11-27", time: "09:14", weekday: 5 });
  assert.equal(seoulTime(new Date("2026-11-27T15:30:00Z")).date, "2026-11-28"); // 00:30 next day in Seoul
  assert.equal(isWeekend("2026-11-28"), true);
  assert.throws(() => parseAt("tomorrow"), /must look like/);
});

test("a date is matched to the notice whose period covers it, not the newest", async () => {
  const s = stubFetch();
  try {
    const sem = await timetableFor("2026-11-27", true);
    assert.equal(sem.kind === "found" && sem.timetable.noticeId, "943967");
    const win = await timetableFor("2025-12-30", true);
    assert.equal(win.kind === "found" && win.timetable.noticeId, "942183");
  } finally {
    s.restore();
  }
});

test("a date past every published period reports none, with the latest for context", async () => {
  const s = stubFetch();
  try {
    const r = await timetableFor("2026-12-22", true);
    assert.equal(r.kind, "none");
    assert.equal(r.kind === "none" && r.latest?.noticeId, "943967");
  } finally {
    s.restore();
  }
});

test("a notice that will not load is an error, never a false 'no timetable'", async () => {
  fs.rmSync(path.join(process.env.LEARNUS_MCP_HOME!, "courses"), { recursive: true, force: true }); // no stale copy to fall back on
  const s = stubFetch({ "943494": 500, "942657": 500, "942183": 500 });
  try {
    await assert.rejects(timetableFor("2025-12-30", true), /Could not read \d+ timetable notice.*942183|Could not read \d+ timetable notice.*겨울방학/s);
  } finally {
    s.restore();
  }
});

test("next departures from Sinchon at 09:14 on a Friday", async () => {
  const s = stubFetch();
  try {
    const r = await nextDepartures("sinchon", parseAt("2026-11-27T09:14"), 3, true);
    assert.deepEqual(r.departures.map((u) => u.departure.time), ["09:30", "10:30", "11:30"]);
    assert.equal(r.stopped, undefined);
  } finally {
    s.restore();
  }
});

test("a bus leaving this very minute still counts", async () => {
  const s = stubFetch();
  try {
    const r = await nextDepartures("sinchon", parseAt("2026-11-27T09:30"), 1, true);
    assert.equal(r.departures[0].departure.time, "09:30");
  } finally {
    s.restore();
  }
});

test("after the last bus on Friday the weekend is skipped to Monday", async () => {
  const s = stubFetch();
  try {
    const r = await nextDepartures("sinchon", parseAt("2026-11-27T22:55"), 3, true);
    assert.deepEqual(r.skipped, ["2026-11-28", "2026-11-29"]);
    assert.deepEqual(r.departures.map((u) => `${u.date} ${u.departure.time}`), ["2026-11-30 07:00", "2026-11-30 07:20", "2026-11-30 07:40"]);
  } finally {
    s.restore();
  }
});

test("the search stops, and says why, when the next day has no published timetable", async () => {
  const s = stubFetch();
  try {
    const r = await nextDepartures("songdo", parseAt("2026-12-21T20:00"), 5, true);
    assert.deepEqual(r.departures.map((u) => u.departure.time), ["20:00", "20:30", "20:50"]);
    assert.match(r.stopped ?? "", /2026-12-22/);
  } finally {
    s.restore();
  }
});

/* ---------------------------------------------------------------- tools --- */

const tools = Object.fromEntries(shuttleTools().map((t) => [t.name, t]));
const run = async (name: string, args: Record<string, unknown>) => (await tools[name].handler(args)).content[0].text as string;

test("shuttle_next cites its source and the reservation rules", async () => {
  const s = stubFetch();
  try {
    const out = await run("shuttle_next", { from: "sinchon", count: 2, at: "2026-11-27T09:14", refresh: true });
    assert.match(out, /Sinchon → Songdo/);
    assert.match(out, /09:30 {2}버스5호 {2}— today, in 16 min/);
    assert.match(out, /Source: 2026학년도 2학기 국제캠퍼스 셔틀버스 운행 시간표 — posted 2026-08-27, valid 2026-09-01 to 2026-12-21/);
    assert.match(out, /portal\.yonsei\.ac\.kr.*셔틀버스 예약/);
    assert.match(out, /public holidays are not checked/);
    assert.doesNotMatch(out, /Songdo → Sinchon/, "only the requested direction");
  } finally {
    s.restore();
  }
});

test("shuttle_timetable lists the whole day for a weekend date with a warning", async () => {
  const s = stubFetch();
  try {
    const out = await run("shuttle_timetable", { date: "2026-11-28", direction: "songdo_to_sinchon", refresh: true });
    assert.match(out, /2026-11-28 is a weekend/);
    assert.equal((out.match(/^- \d\d:\d\d/gm) ?? []).length, 24);
    assert.match(out, /20:50/);
  } finally {
    s.restore();
  }
});

test("shuttle_timetable for an uncovered date says so instead of guessing", async () => {
  const s = stubFetch();
  try {
    const out = await run("shuttle_timetable", { date: "2026-12-22", refresh: true });
    assert.match(out, /No published shuttle timetable covers 2026-12-22/);
    assert.match(out, /may not be posted yet/);
  } finally {
    s.restore();
  }
});

test("with Yonsei unreachable and nothing cached, the error carries the official link", async () => {
  fs.rmSync(path.join(process.env.LEARNUS_MCP_HOME!, "courses"), { recursive: true, force: true });
  const real = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as typeof fetch;
  try {
    const r = await tools.shuttle_next.handler({ at: "2026-11-27T09:14" });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /could not be reached and nothing is cached/);
    assert.match(r.content[0].text, /yonsei\.ac\.kr\/sc\/364/);
  } finally {
    globalThis.fetch = real;
  }
});

test("a cached copy is served, labelled stale, when Yonsei goes down", async () => {
  const s = stubFetch();
  try {
    await run("shuttle_next", { from: "sinchon", at: "2026-11-27T09:14", refresh: true }); // warm the cache
  } finally {
    s.restore();
  }
  const real = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
  try {
    const out = await run("shuttle_next", { from: "sinchon", at: "2026-11-27T09:14", refresh: true });
    assert.match(out, /09:30/);
    assert.match(out, /could not be reached; this is cached data from/);
  } finally {
    globalThis.fetch = real;
  }
});

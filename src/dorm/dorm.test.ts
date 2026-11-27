import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Before anything imports ./learnus/config.js, so nothing lands in the real home.
process.env.LEARNUS_MCP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "learnus-mcp-dorm-"));

const { encodeMenuId, encodePgmId, encodeBody, encodeArgs, dataMap, dataSet } = await import("./wire.js");
const P = await import("./parse.js");
const { checkBooking, checkDate, hoursFor, bookableWindow } = await import("./rules.js");
const { SeminarRooms, ENDPOINTS, WRITE_ENDPOINTS, MENU, ranges } = await import("./service.js");
const { seminarRoomTools } = await import("./index.js");

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/dorm");
const fx = (name: string) => fs.readFileSync(path.join(dir, name), "utf8");

/* ------------------------------------------------------------------ wire */

test("menu and program ids encode exactly as the live page sends them", () => {
  assert.equal(encodeMenuId("M106188"), "MTEwOTM1OTU1MzY3MjA2ODMwMDA=");
  assert.equal(encodePgmId("P004872"), "NDgyNTU3ODgzNjY=");
  // The Sinchon page's id, seen in a blocked request from that page.
  assert.equal(encodeMenuId("M107901"), "MTE2MzkxMDA3MzQ1NTM0NTAwMDA=");
});

test("the booking body matches, byte for byte, what the page itself builds", () => {
  // Captured from the page's own J.Submit.send with the network call blocked
  // (student number replaced; event fields were dummy values).
  const observed =
    "_menuId=MTEwOTM1OTU1MzY3MjA2ODMwMDA=&_menuNm=세미나실, 댄스/밴드연습실 예약&_pgmId=NDgyNTU3ODgzNjY=&@d1#semrmResveNo=&@d1#stuno=0000000000&@d1#resveDt=20261128&@d1#campsDivCd=G&@d1#semrmCd=C0102&@d1#semrmNm=&@d1#evntNm=EVNAME&@d1#evntPrgrsGrpNm=GRPNAME&@d1#evntKindDivCd=50&@d1#evntPcnt=3&@d1#imdtlAprvlYn=1&@d1#cnfmrEmpno=&@d1#aprvlDt=&@d1#aplySttusDivCd=30&@d1#returResnCtnt=&@d1#sts=i&@d#=@d1#&@d1#=dsSdom450&@d1#tp=ds&@d2#fullNm=10:00 ~ 10:50&@d2#useBeginTimeDivCd=10&@d2#sts=i&@d#=@d2#&@d2#=dsSdom460&@d2#tp=ds&";
  const body = encodeBody(
    MENU,
    dataSet(
      1,
      "dsSdom450",
      ["semrmResveNo", "stuno", "resveDt", "campsDivCd", "semrmCd", "semrmNm", "evntNm", "evntPrgrsGrpNm", "evntKindDivCd", "evntPcnt", "imdtlAprvlYn", "cnfmrEmpno", "aprvlDt", "aplySttusDivCd", "returResnCtnt"],
      [{ stuno: "0000000000", resveDt: "20261128", campsDivCd: "G", semrmCd: "C0102", evntNm: "EVNAME", evntPrgrsGrpNm: "GRPNAME", evntKindDivCd: "50", evntPcnt: 3, imdtlAprvlYn: "1", aplySttusDivCd: "30", returResnCtnt: "" }]
    ),
    dataSet(2, "dsSdom460", ["fullNm", "useBeginTimeDivCd"], [{ fullNm: "10:00 ~ 10:50", useBeginTimeDivCd: "10" }])
  );
  assert.equal(decodeURIComponent(body), observed);
});

test("search conditions and the cancel call use the page's shapes", () => {
  assert.equal(
    decodeURIComponent(encodeBody(MENU, dataMap(1, "dmCond", { campsDivCd: "G", semrmCd: "C0102", stdrDt: "20261127" }))),
    "_menuId=MTEwOTM1OTU1MzY3MjA2ODMwMDA=&_menuNm=세미나실, 댄스/밴드연습실 예약&_pgmId=NDgyNTU3ODgzNjY=&@d1#campsDivCd=G&@d1#semrmCd=C0102&@d1#stdrDt=20261127&@d#=@d1#&@d1#=dmCond&@d1#tp=dm&"
  );
  assert.equal(
    decodeURIComponent(encodeArgs(MENU, { semrmResveNo: "123" })),
    "semrmResveNo=123&_menuId=MTEwOTM1OTU1MzY3MjA2ODMwMDA=&_menuNm=세미나실, 댄스/밴드연습실 예약&_pgmId=NDgyNTU3ODgzNjY=&"
  );
});

/* --------------------------------------------------------------- parsers */

test("room lists parse by field name, for both Songdo buildings", () => {
  const one = P.parseRooms(fx("rooms-songdo1.json"));
  assert.equal(one.length, 14);
  assert.deepEqual(one[0], { code: "B0138", name: "밴드 연습실 B138", building: "S11", capacity: 10, maxHours: 4, immediateApproval: true, approvalFlag: "1", campus: "G" });
  assert.equal(one.find((r) => r.code === "C0107")!.capacity, 8);
  const two = P.parseRooms(fx("rooms-songdo2.json"));
  assert.equal(two.length, 28);
  assert.ok(two.every((r) => r.building === "S21" && r.code.startsWith("D")));
});

test("room details carry opening hours, people and hour limits", () => {
  const info = P.parseRoomInfo(fx("room-info-C0102.json"));
  assert.equal(info.openFrom, 9);
  assert.equal(info.openUntil, 24);
  assert.equal(info.capacity, 15);
  assert.equal(info.minPeople, 6);
  assert.equal(info.maxHours, 4);
  assert.equal(info.minHours, 1);
  assert.match(info.remark!, /15 Tables, 15 Chairs/);
});

test("slots: only free hours are listed, hourly HH:00–HH:50", () => {
  const free = P.parseSlots(fx("slots-partly-taken.json"));
  assert.deepEqual(free.map((s) => s.hour), ["09", "10", "11", "12", "13", "14", "15", "16", "17", "18", "23"]);
  assert.deepEqual(free[1], { hour: "10", start: "10:00", end: "10:50", label: "10:00 ~ 10:50" });
  assert.equal(ranges(free.map((s) => Number(s.hour))), "09:00–19:00, 23:00–24:00");
});

test("page set-up: eligible with a student number, or an empty list when not eligible", () => {
  assert.deepEqual(P.parseInit(fx("init-eligible.json")), { eligible: true, campus: "G", studentNo: "0000000000" });
  assert.deepEqual(P.parseInit(fx("init-not-eligible.json")), { eligible: false, campus: null, studentNo: null });
});

test("an empty reservation list is a real answer, not an error", () => {
  assert.deepEqual(P.parseReservations(fx("reservations-empty.json")), []);
});

test("signed out — JSON or the SSO page, both under HTTP 200 — is a session error", () => {
  for (const body of [fx("signed-out.json"), fx("sso-missing.html")]) {
    assert.throws(() => P.parseSlots(body), (e: any) => e instanceof P.SeminarRoomError && e.kind === "session" && /expired/.test(e.message));
  }
});

test("unknown menu/program ids are reported as a moved page", () => {
  assert.throws(() => P.parseSlots(fx("program-not-found.json")), (e: any) => e.kind === "program" && /P000000-0020/.test(e.message));
});

test("a changed layout says what was expected and what was found", () => {
  assert.throws(() => P.parseSlots('{"dsSomethingElse":[]}'), (e: any) => e.kind === "layout" && /Expected "dsSdom430Pl".*found "dsSomethingElse"/.test(e.message));
  assert.throws(() => P.parseSlots('{"dsSdom430Pl":[{"useBeginTimeDivCd":"10","fullNm":"morning"}]}'), (e: any) => e.kind === "layout" && /"morning"/.test(e.message));
  assert.throws(() => P.parseRooms('{"dsSdom430":[{"semrmNm":"x"}]}'), (e: any) => e.kind === "layout" && /"semrmCd"/.test(e.message));
  assert.throws(() => P.parseRooms("<html><title>점검 중</title></html>"), (e: any) => e.kind === "layout" && /HTML page titled "점검 중"/.test(e.message));
});

test("a refusal the portal words itself is passed on", () => {
  assert.throws(
    () => P.parseWriteResult("the booking", '{"_METADATA_":{"success":false,"msg":"이미 예약된 시간입니다."}}'),
    (e: any) => e.kind === "rejected" && /이미 예약된 시간입니다/.test(e.message)
  );
  assert.deepEqual(P.parseWriteResult("the booking", '{"_METADATA_":{"success":true,"msg":"P000000-0025"}}'), { message: "신청되었습니다. (application submitted) [P000000-0025]" });
});

test("reservation times are read from text ranges or hour codes", () => {
  assert.deepEqual(P.parseTimes("10:00 ~ 10:50, 11:00 ~ 11:50"), ["10:00–10:50", "11:00–11:50"]);
  assert.deepEqual(P.parseTimes("10,11"), ["10:00–10:50", "11:00–11:50"]);
  assert.equal(P.parseTimes(null), null);
});

/* ----------------------------------------------------------------- rules */

const ROOM = P.parseRoomInfo(fx("room-info-C0102.json"));
const FREE = P.parseSlots(fx("slots-partly-taken.json"));
const TODAY = "2026-11-27";
const req = (o: Partial<Parameters<typeof checkBooking>[0]> = {}) => ({
  date: "2026-11-28",
  start: "10:00",
  end: "12:00",
  attendees: 3,
  eventName: "Study group",
  groupName: "UIC study",
  ...o,
});
const invalid = (re: RegExp) => (e: any) => e instanceof P.SeminarRoomError && e.kind === "invalid" && re.test(e.message);

test("booking window: tomorrow through today + 5", () => {
  assert.deepEqual(bookableWindow(TODAY), { first: "2026-11-28", last: "2026-12-02" });
  checkDate("2026-12-02", TODAY);
  assert.throws(() => checkDate(TODAY, TODAY), invalid(/Same-day/));
  assert.throws(() => checkDate("2026-12-03", TODAY), invalid(/5 days ahead.*2026-12-02/));
  assert.throws(() => checkDate("2026-11-20", TODAY), invalid(/past/));
  assert.throws(() => checkDate("2026-02-30", TODAY), invalid(/not a date/));
});

test("time ranges: whole hours, end after start, :50 accepted as the slot end", () => {
  assert.deepEqual(hoursFor("10:00", "12:00"), ["10", "11"]);
  assert.deepEqual(hoursFor("10:00", "11:50"), ["10", "11"]);
  assert.deepEqual(hoursFor("9:00", "10:00"), ["09"]);
  assert.throws(() => hoursFor("12:00", "10:00"), invalid(/after the start/));
  assert.throws(() => hoursFor("10:00", "10:00"), invalid(/after the start/));
  assert.throws(() => hoursFor("10:30", "12:00"), invalid(/on the hour/));
  assert.throws(() => hoursFor("10:00", "11:30"), invalid(/:50/));
});

test("a valid request yields the slots to book", () => {
  assert.deepEqual(checkBooking(req(), TODAY, ROOM, FREE).map((s) => s.label), ["10:00 ~ 10:50", "11:00 ~ 11:50"]);
});

test("rules from the page are enforced before anything is sent", () => {
  assert.throws(() => checkBooking(req({ start: "09:00", end: "14:00" }), TODAY, ROOM, FREE), invalid(/at most 4 hours.*5/));
  assert.throws(() => checkBooking(req({ start: "19:00", end: "20:00" }), TODAY, ROOM, FREE), invalid(/not free.*19:00.*Free slots/));
  assert.throws(() => checkBooking(req({ start: "08:00", end: "09:00" }), TODAY, ROOM, FREE), invalid(/09:00–24:00.*08:00/));
  assert.throws(() => checkBooking(req({ attendees: 16 }), TODAY, ROOM, FREE), invalid(/holds 15/));
  assert.throws(() => checkBooking(req({ eventName: " " }), TODAY, ROOM, FREE), invalid(/event name/));
  assert.throws(() => checkBooking(req({ groupName: "" }), TODAY, ROOM, FREE), invalid(/group name/));
  assert.throws(() => checkBooking(req({ eventName: "가".repeat(67) }), TODAY, ROOM, FREE), invalid(/201 bytes/));
});

/* ------------------------------------------------- the confirmation gate */

interface Call {
  path: string;
  body: string;
}

/** A portal that answers from fixtures and records every call. */
function fakePortal(opts: { reservations?: () => string; detail?: (no: string) => string; signedOutOnce?: string; write?: () => string } = {}) {
  const calls: Call[] = [];
  const resets: Array<{ fresh?: boolean }> = [];
  let signedOut = opts.signedOutOnce;
  const transport = {
    async post(p: string, body: string) {
      calls.push({ path: p, body });
      if (signedOut && p === signedOut) {
        signedOut = undefined;
        return fx("signed-out.json");
      }
      const b = decodeURIComponent(body);
      if (p === ENDPOINTS.init) return fx("init-eligible.json");
      if (p === ENDPOINTS.rooms) return b.includes("dormtBuldDivCd=S11") ? fx("rooms-songdo1.json") : fx("rooms-songdo2.json");
      if (p === ENDPOINTS.info) return fx("room-info-C0102.json");
      if (p === ENDPOINTS.slots) return fx("slots-partly-taken.json");
      if (p === ENDPOINTS.list) {
        const no = b.match(/semrmResveNo=(\w+)/)?.[1];
        if (no) return opts.detail ? opts.detail(no) : fx("reservations-empty.json");
        return opts.reservations ? opts.reservations() : fx("reservations-empty.json");
      }
      if (WRITE_ENDPOINTS.includes(p)) return opts.write ? opts.write() : '{"_METADATA_":{"success":true}}';
      throw new Error(`unexpected path ${p}`);
    },
    async reset(o?: { fresh?: boolean }) {
      resets.push(o ?? {});
    },
  };
  return { calls, resets, transport, writes: () => calls.filter((c) => WRITE_ENDPOINTS.includes(c.path)) };
}

const NOW = () => new Date("2026-11-27T11:30:00+09:00");
const BOOK = { date: "2026-11-28", room: "C0102", start: "10:00", end: "12:00", eventName: "Study group", groupName: "UIC study", eventKind: "seminar" as const, attendees: 3 };

test("seminar_room_book without confirm never calls the submit endpoint and returns a preview", async () => {
  const portal = fakePortal();
  const svc = new SeminarRooms({ transport: portal.transport, now: NOW });
  for (const confirm of [undefined, false]) {
    const r = await svc.book({ ...BOOK, confirm });
    assert.equal(r.submitted, false);
    assert.match(r.text, /^PREVIEW — nothing has been booked/);
    assert.match(r.text, /중세미나실 C0102/);
    assert.match(r.text, /2026-11-28 \(Sat\)/);
    assert.match(r.text, /10:00–11:50 \(2 slots/);
    assert.match(r.text, /confirm: true/);
  }
  assert.equal(portal.writes().length, 0);
});

test("the tool itself defaults to preview, and the student number never reaches the output", async () => {
  const portal = fakePortal();
  const tools = seminarRoomTools({ transport: portal.transport, now: NOW });
  const book = tools.find((t) => t.name === "seminar_room_book")!;
  const res = await book.handler({ date: "2026-11-28", room: "C0102", start: "10:00", end: "12:00", event_name: "Study", group_name: "Me", event_kind: "meeting", attendees: 2 });
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /PREVIEW/);
  assert.doesNotMatch(res.content[0].text, /0000000000/);
  assert.equal(portal.writes().length, 0);
});

test("a rule violation is refused before any portal write, even with confirm", async () => {
  const portal = fakePortal();
  const svc = new SeminarRooms({ transport: portal.transport, now: NOW });
  await assert.rejects(svc.book({ ...BOOK, date: "2026-11-27", confirm: true }), invalid(/Same-day/));
  await assert.rejects(svc.book({ ...BOOK, start: "19:00", end: "20:00", confirm: true }), invalid(/not free/));
  await assert.rejects(svc.book({ ...BOOK, room: "Z9999", confirm: true }), invalid(/No bookable room "Z9999".*C0102/));
  assert.equal(portal.writes().length, 0);
});

// The reservation-list row below is shaped from the page's declared columns
// (dsSdom450H); replace it with a sanitized live capture once one exists.
const listRow = (no: string, status = "30", times?: string) =>
  JSON.stringify({
    dsSdom450: [
      { semrmResveNo: no, stuno: "0000000000", resveDt: "20261128", campsDivCd: "G", semrmCd: "C0102", semrmNm: "중세미나실 C0102", evntNm: "Study group", evntPrgrsGrpNm: "UIC study", evntKindDivCd: "50", evntPcnt: 3, imdtlAprvlYn: "1", aplySttusDivCd: status, returResnCtnt: null, ...(times ? { useBeginTimeDivCd: times } : {}) },
    ],
  });

test("with confirm, the booking is sent once and the answer is what the portal then lists", async () => {
  let booked = false;
  const portal = fakePortal({
    reservations: () => (booked ? listRow("777") : fx("reservations-empty.json")),
    detail: (no) => listRow(no, "30", "10:00 ~ 10:50, 11:00 ~ 11:50"),
    write: () => {
      booked = true;
      return '{"_METADATA_":{"success":true}}';
    },
  });
  const svc = new SeminarRooms({ transport: portal.transport, now: NOW });
  const r = await svc.book({ ...BOOK, confirm: true });
  assert.equal(r.submitted, true);
  assert.equal(portal.writes().length, 1);
  assert.equal(portal.writes()[0].path, ENDPOINTS.book);
  const sent = decodeURIComponent(portal.writes()[0].body);
  assert.match(sent, /@d1#stuno=0000000000&@d1#resveDt=20261128&@d1#campsDivCd=G&@d1#semrmCd=C0102&/);
  assert.match(sent, /@d1#evntKindDivCd=50&@d1#evntPcnt=3&@d1#imdtlAprvlYn=1&/);
  assert.match(sent, /@d2#fullNm=10:00 ~ 10:50&@d2#useBeginTimeDivCd=10&@d2#sts=i&@d2#fullNm=11:00 ~ 11:50&@d2#useBeginTimeDivCd=11&/);
  assert.match(r.text, /^Booked\. The portal now lists:\n#777 · 2026-11-28 \(Sat\) · 중세미나실 C0102/);
  assert.match(r.text, /time: 10:00–10:50, 11:00–11:50/);
  assert.match(r.text, /승인 \(approved\)/);
});

test("if the portal accepts but does not list the booking, the answer says so", async () => {
  const portal = fakePortal();
  const r = await new SeminarRooms({ transport: portal.transport, now: NOW }).book({ ...BOOK, confirm: true });
  assert.equal(portal.writes().length, 1);
  assert.match(r.text, /does not show a new booking/);
});

test("a refused booking reports the portal's reason and is not retried", async () => {
  const portal = fakePortal({ write: () => '{"_METADATA_":{"success":false,"msg":"1일 최대 예약 시간을 초과하였습니다."}}' });
  await assert.rejects(new SeminarRooms({ transport: portal.transport, now: NOW }).book({ ...BOOK, confirm: true }), (e: any) => e.kind === "rejected" && /1일 최대/.test(e.message));
  assert.equal(portal.writes().length, 1);
});

test("an expired session on the submit itself is not retried", async () => {
  const portal = fakePortal({ write: () => fx("signed-out.json") });
  await assert.rejects(new SeminarRooms({ transport: portal.transport, now: NOW }).book({ ...BOOK, confirm: true }), (e: any) => e.kind === "session");
  assert.equal(portal.writes().length, 1);
  assert.equal(portal.resets.length, 0);
});

test("seminar_room_cancel without confirm never calls the cancel endpoint", async () => {
  const portal = fakePortal({ detail: (no) => listRow(no) });
  const r = await new SeminarRooms({ transport: portal.transport, now: NOW }).cancel({ number: "777" });
  assert.equal(r.submitted, false);
  assert.match(r.text, /^PREVIEW — nothing has been cancelled/);
  assert.match(r.text, /#777 · 2026-11-28/);
  assert.equal(portal.writes().length, 0);
});

test("cancel with confirm sends the number once and reports the portal's new status", async () => {
  let cancelled = false;
  const portal = fakePortal({
    detail: (no) => listRow(no, cancelled ? "90" : "30"),
    write: () => {
      cancelled = true;
      return '{"_METADATA_":{"success":true}}';
    },
  });
  const r = await new SeminarRooms({ transport: portal.transport, now: NOW }).cancel({ number: "#777", confirm: true });
  assert.equal(portal.writes().length, 1);
  assert.equal(portal.writes()[0].path, ENDPOINTS.cancel);
  assert.match(decodeURIComponent(portal.writes()[0].body), /^semrmResveNo=777&_menuId=/);
  assert.match(r.text, /^Cancelled\. The portal now shows:/);
  assert.match(r.text, /취소 \(cancelled\)/);
});

test("cancelling what cannot be cancelled is refused without a write", async () => {
  const svc = (status: string, date = "20261128") =>
    new SeminarRooms({ transport: fakePortal({ detail: (no) => listRow(no, status).replace("20261128", date) }).transport, now: NOW });
  await assert.rejects(svc("90").cancel({ number: "1", confirm: true }), invalid(/already cancelled/));
  await assert.rejects(svc("99").cancel({ number: "1", confirm: true }), invalid(/rejected/));
  await assert.rejects(svc("30", "20261120").cancel({ number: "1", confirm: true }), invalid(/has passed/));
  await assert.rejects(new SeminarRooms({ transport: fakePortal().transport, now: NOW }).cancel({ number: "404", confirm: true }), (e: any) => /not found/.test(e.message));
});

/* ---------------------------------------------------------------- reads */

test("an expired session on a read signs in again once (fresh SSO) and repeats it", async () => {
  const portal = fakePortal({ signedOutOnce: ENDPOINTS.init });
  const text = await new SeminarRooms({ transport: portal.transport, now: NOW }).availability({ date: "2026-11-28", days: 1, room: "C0102" });
  assert.deepEqual(portal.resets, [{ fresh: true }]);
  assert.match(text, /C0102 중세미나실 C0102 \[송도1학사/);
  assert.match(text, /free: 09:00–19:00, 23:00–24:00\n\s+taken: 19:00–23:00/);
});

test("an account that may not book gets a specific answer, not an empty list", async () => {
  const portal = fakePortal();
  portal.transport.post = (async (p: string, b: string) => (p === ENDPOINTS.init ? fx("init-not-eligible.json") : "")) as any;
  await assert.rejects(new SeminarRooms({ transport: portal.transport, now: NOW }).myReservations({ includePast: false, limit: 5 }), (e: any) => e.kind === "not_eligible" && /신청가능 대상자가 아닙니다/.test(e.message));
});

test("today is marked view-only and its started hours are past, not taken", async () => {
  const portal = fakePortal();
  portal.transport.post = (async (p: string, b: string) => {
    if (p === ENDPOINTS.slots) return fx("slots-same-day.json");
    return (fakePortal().transport.post as any)(p, b);
  }) as any;
  const text = await new SeminarRooms({ transport: portal.transport, now: NOW }).availability({ date: "2026-11-27", days: 1, room: "C0102" });
  assert.match(text, /2026-11-27 \(Fri\) — today: viewing only/);
  assert.match(text, /free: 12:00–24:00/);
  assert.match(text, /already past: 09:00–12:00/);
  assert.doesNotMatch(text, /taken:/);
});

test("no reservations is said plainly", async () => {
  const text = await new SeminarRooms({ transport: fakePortal().transport, now: NOW }).myReservations({ includePast: true, limit: 5 });
  assert.match(text, /lists no seminar-room reservations/);
});

/**
 * The four operations behind the seminar-room tools, over an injectable
 * transport so tests can run them against recorded answers and prove that a
 * preview never reaches the submit endpoints.
 *
 * Reads that hit an expired session sign in again once. Writes never retry:
 * the session is checked just before, the request is sent once, and the result
 * is whatever the portal's own reservation list shows afterwards.
 */
import { addDays, seoulTime, weekdayOf } from "../time.js";
import {
  BUILDINGS,
  EVENT_KINDS,
  SeminarRoomError,
  parseInit,
  parseReservationDetail,
  parseReservations,
  parseRoomInfo,
  parseRooms,
  parseSlots,
  parseWriteResult,
  statusLabel,
  type BuildingCode,
  type EventKind,
  type Reservation,
  type Room,
  type RoomInfo,
  type Slot,
} from "./parse.js";
import { bookableWindow, checkBooking, checkDate } from "./rules.js";
import type { Transport } from "./portal.js";
import { dataMap, dataSet, encodeArgs, encodeBody, type Menu } from "./wire.js";

/** 학사행정 → 기숙사 → 세미나실, 댄스/밴드연습실 예약 (Songdo). */
export const MENU: Menu = { menuId: "M106188", pgmId: "P004872", menuNm: "세미나실, 댄스/밴드연습실 예약" };
const API = "/sch/sdom/SdombkCtr";
export const ENDPOINTS = {
  init: `${API}/findSemrmResveAplyInit.do`,
  rooms: `${API}/findBkblSemrmList.do`,
  slots: `${API}/findBkblSemrmPlanList.do`,
  list: `${API}/findSemrmResveAplyList.do`,
  info: "/sch/sdom/SdombmCtr/findSdomSemRmList.do",
  book: `${API}/saveSemrmResveAplyList.do`,
  cancel: `${API}/saveSemrmResveAplyCancel.do`,
} as const;
export const WRITE_ENDPOINTS: string[] = [ENDPOINTS.book, ENDPOINTS.cancel];

/** Songdo is campus "G" in the portal; this page serves only it. */
const CAMPUS = "G";
const ALL_BUILDINGS = Object.keys(BUILDINGS) as BuildingCode[];
const ymd = (date: string) => date.replace(/-/g, "");

export interface Deps {
  transport: Transport;
  now?: () => Date;
}

export interface RoomDay {
  room: Room;
  info: RoomInfo;
  free: Slot[];
}

export interface BookInput {
  date: string;
  room: string;
  start: string;
  end: string;
  eventName: string;
  groupName: string;
  eventKind: EventKind;
  attendees: number;
  confirm?: boolean;
}

export interface WriteOutcome {
  submitted: boolean;
  text: string;
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

const hh = (n: number) => `${String(n).padStart(2, "0")}:00`;

/** Hours → "09:00–12:00, 14:00–15:00". */
export function ranges(hours: number[]): string {
  const sorted = [...new Set(hours)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(`${hh(sorted[i])}–${hh(sorted[j] + 1)}`);
    i = j + 1;
  }
  return parts.join(", ");
}

export function describeReservation(r: Reservation): string {
  return [
    `#${r.number} · ${r.date} (${weekdayOf(r.date)}) · ${r.roomName ?? r.roomCode}`,
    r.times?.length ? `  time: ${r.times.join(", ")}` : null,
    `  status: ${statusLabel(r.status)}${r.rejectReason ? ` — reason: ${r.rejectReason}` : ""}`,
    r.eventName || r.groupName ? `  event: ${r.eventName ?? "?"} · group: ${r.groupName ?? "?"}${r.people ? ` · ${r.people} people` : ""}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export class SeminarRooms {
  private readonly infoCache = new Map<string, RoomInfo>();

  constructor(private readonly deps: Deps) {}

  today(): string {
    return seoulTime(this.deps.now?.() ?? new Date()).date;
  }

  /** A read: on an expired session, sign in again (fresh SSO on the second try) and repeat once. */
  private async read<T>(path: string, body: string, parse: (text: string) => T): Promise<T> {
    try {
      return parse(await this.deps.transport.post(path, body));
    } catch (err) {
      if (!(err instanceof SeminarRoomError) || err.kind !== "session") throw err;
      await this.deps.transport.reset({ fresh: true });
      return parse(await this.deps.transport.post(path, body));
    }
  }

  async eligibility() {
    const e = await this.read(ENDPOINTS.init, encodeBody(MENU, dataMap(1, "dmCond", { dormtBuldDivCd: "", stdrDt: "", campsDivCd: "" })), parseInit);
    if (!e.eligible) {
      throw new SeminarRoomError(
        "not_eligible",
        "The portal says this account may not book Songdo dormitory rooms (the page shows \"신청가능 대상자가 아닙니다\" — not an eligible applicant). Booking is for current Songdo dormitory residents."
      );
    }
    if (e.campus !== CAMPUS) {
      throw new SeminarRoomError("layout", `Expected the Songdo campus code "${CAMPUS}" from the page set-up; got "${e.campus}".`);
    }
    return e;
  }

  rooms(building: BuildingCode, date: string): Promise<Room[]> {
    return this.read(
      ENDPOINTS.rooms,
      encodeBody(MENU, dataMap(1, "dmCond", { dormtBuldDivCd: building, stdrDt: ymd(date), campsDivCd: CAMPUS })),
      parseRooms
    );
  }

  async roomInfo(code: string): Promise<RoomInfo> {
    const hit = this.infoCache.get(code);
    if (hit) return hit;
    const info = await this.read(ENDPOINTS.info, encodeBody(MENU, dataMap(1, "dmCond", { campsDivCd: CAMPUS, semrmCd: code })), parseRoomInfo);
    this.infoCache.set(code, info);
    return info;
  }

  slots(code: string, date: string): Promise<Slot[]> {
    return this.read(ENDPOINTS.slots, encodeBody(MENU, dataMap(1, "dmCond", { campsDivCd: CAMPUS, semrmCd: code, stdrDt: ymd(date) })), parseSlots);
  }

  /** Every reservation the portal lists for this account, newest date first, de-duplicated across buildings. */
  async reservations(): Promise<Reservation[]> {
    const today = ymd(this.today());
    const lists = await pool(ALL_BUILDINGS, 2, (b) =>
      this.read(ENDPOINTS.list, encodeBody(MENU, dataMap(1, "dmCond", { dormtBuldDivCd: b, stdrDt: today, campsDivCd: CAMPUS })), parseReservations)
    );
    const byNo = new Map<string, Reservation>();
    for (const r of lists.flat()) byNo.set(r.number, r);
    return [...byNo.values()].sort((a, b) => (a.date === b.date ? b.number.localeCompare(a.number) : b.date.localeCompare(a.date)));
  }

  detail(number: string): Promise<Reservation> {
    return this.read(ENDPOINTS.list, encodeBody(MENU, dataMap(1, "dmCond", { semrmResveNo: number })), (t) => parseReservationDetail(t, number));
  }

  /** Find a room by code ("C0102") or by the number in its name ("B138"), across both buildings. */
  async findRoom(query: string, date: string): Promise<Room> {
    const all = (await pool(ALL_BUILDINGS, 2, (b) => this.rooms(b, date))).flat();
    const q = query.trim().toUpperCase();
    const hit = all.find((r) => r.code.toUpperCase() === q) ?? all.find((r) => r.name.toUpperCase().split(/\s+/).includes(q));
    if (!hit) {
      throw new SeminarRoomError(
        "invalid",
        `No bookable room "${query}" on ${date}. Rooms: ${all.map((r) => `${r.code} (${r.name})`).join(", ") || "none listed"}.`
      );
    }
    return hit;
  }

  /* ---------------------------------------------------------------- reads */

  async availability(opts: { date: string; days: number; building?: BuildingCode; room?: string }): Promise<string> {
    const today = this.today();
    const window = bookableWindow(today);
    await this.eligibility();
    const buildings = opts.building ? [opts.building] : ALL_BUILDINGS;
    const out: string[] = [`Today is ${today} (Seoul). Bookable dates: ${window.first} to ${window.last}.`];

    for (let d = 0; d < opts.days; d++) {
      const date = addDays(opts.date, d);
      let rooms = (await pool(buildings, 2, (b) => this.rooms(b, date))).flat();
      if (opts.room) {
        const q = opts.room.trim().toUpperCase();
        rooms = rooms.filter((r) => r.code.toUpperCase() === q || r.name.toUpperCase().split(/\s+/).includes(q));
        if (!rooms.length) throw new SeminarRoomError("invalid", `No room "${opts.room}" in ${buildings.map((b) => BUILDINGS[b]).join(" or ")} on ${date}.`);
      }
      const days: RoomDay[] = await pool(rooms, 6, async (room) => ({ room, info: await this.roomInfo(room.code), free: await this.slots(room.code, date) }));

      let note = "";
      if (date < today) note = " — in the past";
      else if (date === today) note = " — today: viewing only, same-day booking is not allowed";
      else if (date > window.last) note = ` — viewing only, bookings open ${addDays(date, -5)}`;
      const lines = [`\n${date} (${weekdayOf(date)})${note}`];
      if (!days.length) lines.push("  No rooms listed for this date.");
      for (const { room, info, free } of days) {
        const open: number[] = [];
        for (let h = info.openFrom; h < info.openUntil; h++) open.push(h);
        const freeH = free.map((s) => Number(s.hour));
        const busy = open.filter((h) => !freeH.includes(h));
        // Today the portal drops slots that have started; those are past, not taken.
        const nowHour = Number(seoulTime(this.deps.now?.() ?? new Date()).time.slice(0, 2));
        const pastToday = date === today ? busy.filter((h) => h <= nowHour) : [];
        const taken = busy.filter((h) => !pastToday.includes(h));
        lines.push(
          `  ${room.code} ${room.name} [${BUILDINGS[room.building as BuildingCode] ?? room.building}] · up to ${room.capacity} people · max ${Math.min(room.maxHours, 4)}h` +
            `\n    free: ${ranges(freeH) || "nothing"}` +
            (taken.length ? `\n    taken: ${ranges(taken)}` : "") +
            (pastToday.length ? `\n    already past: ${ranges(pastToday)}` : "")
        );
      }
      out.push(lines.join("\n"));
    }
    out.push(
      "\nSlots are one hour (HH:00–HH:50) between each room's opening hours. \"Taken\" means the portal does not offer the slot: someone booked it, or it is otherwise closed."
    );
    return out.join("\n");
  }

  async myReservations(opts: { includePast: boolean; limit: number }): Promise<string> {
    await this.eligibility();
    const today = this.today();
    const all = await this.reservations();
    const shown = all.filter((r) => opts.includePast || r.date >= today).slice(0, opts.limit);
    if (!shown.length) {
      return all.length
        ? `No upcoming seminar-room reservations. ${all.length} past one(s) exist; ask with include_past to see them.`
        : "The portal lists no seminar-room reservations for this account.";
    }
    const detailed = await pool(shown, 4, (r) => this.detail(r.number).catch(() => r));
    const upcoming = detailed.filter((r) => r.date >= today);
    const past = detailed.filter((r) => r.date < today);
    return [
      upcoming.length ? `Upcoming (${upcoming.length}):\n${upcoming.map(describeReservation).join("\n")}` : "No upcoming reservations.",
      past.length ? `\nPast (${past.length}):\n${past.map(describeReservation).join("\n")}` : null,
      `\nA reservation can be cancelled until its date (the page offers 취소 while the date is today or later and it was not rejected).`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  /* --------------------------------------------------------------- writes */

  async book(input: BookInput): Promise<WriteOutcome> {
    const today = this.today();
    checkDate(input.date, today);
    const kind = EVENT_KINDS[input.eventKind];
    const { studentNo } = await this.eligibility();
    const room = await this.findRoom(input.room, input.date);
    const info = await this.roomInfo(room.code);
    const free = await this.slots(room.code, input.date);
    const slots = checkBooking(
      { date: input.date, start: input.start, end: input.end, attendees: input.attendees, eventName: input.eventName, groupName: input.groupName },
      today,
      info,
      free
    );
    const first = slots[0];
    const last = slots[slots.length - 1];
    const summary = [
      `Room: ${room.name} (${room.code}), ${BUILDINGS[room.building as BuildingCode] ?? room.building}, up to ${room.capacity} people`,
      `Date: ${input.date} (${weekdayOf(input.date)})`,
      `Time: ${first.start}–${last.end} (${slots.length} slot${slots.length > 1 ? "s" : ""}: ${slots.map((s) => s.label).join(", ")})`,
      `Event: ${input.eventName} · group: ${input.groupName} · ${kind.label} · ${input.attendees} people`,
      room.immediateApproval
        ? "Approval: this room is approved immediately (status 승인)."
        : "Approval: this room needs approval; the booking waits as 신청 until the dormitory office approves it.",
    ];
    if (info.minPeople && input.attendees < info.minPeople) {
      summary.push(`Note: the room's details list a minimum of ${info.minPeople} people; the page does not enforce it.`);
    }

    if (!input.confirm) {
      return {
        submitted: false,
        text: [
          "PREVIEW — nothing has been booked.",
          ...summary,
          "",
          "Show this to the user and ask for a clear yes. To book, call seminar_room_book again with the same arguments and confirm: true.",
        ].join("\n"),
      };
    }

    const before = new Set((await this.reservations()).map((r) => r.number));
    const body = encodeBody(
      MENU,
      dataSet(
        1,
        "dsSdom450",
        ["semrmResveNo", "stuno", "resveDt", "campsDivCd", "semrmCd", "semrmNm", "evntNm", "evntPrgrsGrpNm", "evntKindDivCd", "evntPcnt", "imdtlAprvlYn", "cnfmrEmpno", "aprvlDt", "aplySttusDivCd", "returResnCtnt"],
        [
          {
            stuno: studentNo,
            resveDt: ymd(input.date),
            campsDivCd: CAMPUS,
            semrmCd: room.code,
            evntNm: input.eventName,
            evntPrgrsGrpNm: input.groupName,
            evntKindDivCd: kind.code,
            evntPcnt: input.attendees,
            imdtlAprvlYn: room.approvalFlag,
            // What the page sets: approved at once for immediate-approval rooms, otherwise "applied".
            aplySttusDivCd: room.immediateApproval ? "30" : "20",
            returResnCtnt: "",
          },
        ]
      ),
      dataSet(2, "dsSdom460", ["fullNm", "useBeginTimeDivCd"], slots.map((s) => ({ fullNm: s.label, useBeginTimeDivCd: s.hour })))
    );
    const result = parseWriteResult("the booking (saveSemrmResveAplyList)", await this.deps.transport.post(ENDPOINTS.book, body));

    // The request is out: from here on, a failed read must not read as "not booked".
    let after: Reservation[];
    try {
      after = await this.reservations();
    } catch (err) {
      return {
        submitted: true,
        text: [
          "The booking was sent and the portal accepted it" + (result.message ? ` (${result.message})` : "") + ", but reading the reservation list afterwards failed:",
          err instanceof Error ? err.message : String(err),
          "Check seminar_room_my_reservations or the page before booking again — do not resend.",
          ...summary,
        ].join("\n"),
      };
    }
    const added = after.filter((r) => !before.has(r.number) && r.date === input.date && r.roomCode === room.code);
    if (!added.length) {
      return {
        submitted: true,
        text: [
          "The portal accepted the request" + (result.message ? ` (${result.message})` : "") + ", but its reservation list does not show a new booking for this room and date.",
          "Check the reservation page on the Yonsei Portal before relying on it.",
          ...summary,
        ].join("\n"),
      };
    }
    const shown = await Promise.all(added.map((r) => this.detail(r.number).catch(() => r)));
    return {
      submitted: true,
      text: [`Booked. The portal now lists:`, ...shown.map(describeReservation), result.message ? `Portal message: ${result.message}` : null]
        .filter(Boolean)
        .join("\n"),
    };
  }

  async cancel(input: { number: string; confirm?: boolean }): Promise<WriteOutcome> {
    const number = input.number.trim().replace(/^#/, "");
    if (!number) throw new SeminarRoomError("invalid", "A reservation number is required (seminar_room_my_reservations lists them).");
    const today = this.today();
    await this.eligibility();
    const r = await this.detail(number);
    if (r.status === "90") throw new SeminarRoomError("invalid", `Reservation #${number} is already cancelled.`);
    if (r.status === "99") throw new SeminarRoomError("invalid", `Reservation #${number} was rejected by the dormitory office; there is nothing to cancel.`);
    if (r.date < today) throw new SeminarRoomError("invalid", `Reservation #${number} was for ${r.date}, which has passed; the page only cancels reservations dated today or later.`);

    if (!input.confirm) {
      return {
        submitted: false,
        text: [
          "PREVIEW — nothing has been cancelled.",
          "This would cancel:",
          describeReservation(r),
          "",
          "Show this to the user and ask for a clear yes. To cancel, call seminar_room_cancel again with confirm: true.",
        ].join("\n"),
      };
    }

    const result = parseWriteResult("the cancellation (saveSemrmResveAplyCancel)", await this.deps.transport.post(ENDPOINTS.cancel, encodeArgs(MENU, { semrmResveNo: number })));
    const now: Reservation | Error = await this.detail(number).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));
    if (now instanceof Error) {
      // The portal drops a cancelled reservation entirely, so the lookup by number comes back empty.
      let listed: boolean;
      try {
        listed = (await this.reservations()).some((x) => x.number === number);
      } catch (err) {
        return {
          submitted: true,
          text: `The cancellation of #${number} was sent and the portal accepted it, but reading the reservation list afterwards failed (${err instanceof Error ? err.message : String(err)}). Check seminar_room_my_reservations before trying again — do not resend.`,
        };
      }
      return {
        submitted: true,
        text: listed
          ? `The portal accepted the cancellation, but reservation #${number} is still listed and its details could not be read (${now.message}). Check the page.`
          : `Cancelled. Reservation #${number} no longer appears in the portal's list.`,
      };
    }
    const done = now.status === "90";
    return {
      submitted: true,
      text: [
        done ? `Cancelled. The portal now shows:` : `The portal accepted the cancellation, but it still shows this status — check the page:`,
        describeReservation(now),
        result.message ? `Portal message: ${result.message}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
}

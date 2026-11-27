/**
 * The booking rules the seminar-room page applies before it submits.
 *
 * They live in the page's own script (sdombk0200), not on the server as far as
 * anyone has checked — this tool talks to the server directly, so it applies
 * them itself, with the page's own wording. Pure: no network, no clock.
 *
 * For the Songdo campus (campsDivCd "G") the page says:
 *   - 당일예약 신청은 불가합니다.            no booking for today
 *   - 5일 이내의 예약만 가능합니다.          at most 5 days ahead (today + 5 is the last day)
 *   - 세미나실 최대 이용 시간은 최대 4시간    at most 4 one-hour slots, and the room's own maxUseHcnt
 *   - 세미나실 정원을 초과하여 신청할 수 없습니다. attendees no more than the room's capacity
 *   - 행사명 / 단체명 / 행사종류 / 행사인원 are required (event name ≤ 200 bytes, group ≤ 500)
 */
import { addDays, isRealDate } from "../time.js";
import { SeminarRoomError, type RoomInfo, type Slot } from "./parse.js";

export const MAX_DAYS_AHEAD = 5;
export const CAMPUS_MAX_HOURS = 4;

export interface BookingRequest {
  date: string; // YYYY-MM-DD
  start: string; // HH:MM
  end: string; // HH:MM
  attendees: number;
  eventName: string;
  groupName: string;
}

const fail = (msg: string): never => {
  throw new SeminarRoomError("invalid", msg);
};

/** Window of dates the page accepts: tomorrow through today + 5. */
export function bookableWindow(today: string): { first: string; last: string } {
  return { first: addDays(today, 1), last: addDays(today, MAX_DAYS_AHEAD) };
}

export function checkDate(date: string, today: string): void {
  if (!isRealDate(date)) fail(`"${date}" is not a date; use YYYY-MM-DD.`);
  const { first, last } = bookableWindow(today);
  if (date < today) fail(`${date} is in the past (today is ${today} in Seoul).`);
  if (date === today) fail(`Same-day booking is not allowed (the page: "당일예약 신청은 불가합니다"). The earliest bookable day is ${first}.`);
  if (date > last) fail(`Only bookings up to ${MAX_DAYS_AHEAD} days ahead are allowed (the page: "5일 이내의 예약만 가능합니다"). The last bookable day is ${last}.`);
}

/**
 * `start`–`end` → the page's hourly slot codes. Slots are HH:00–HH:50, so a
 * range starts on the hour and ends on the hour or at :50 of the last slot.
 */
export function hoursFor(start: string, end: string): string[] {
  const s = start.match(/^(\d{1,2}):(\d{2})$/);
  const e = end.match(/^(\d{1,2}):(\d{2})$/);
  if (!s) fail(`Start time "${start}" must look like 14:00.`);
  if (!e) fail(`End time "${end}" must look like 16:00.`);
  const sh = Number(s![1]);
  const sm = Number(s![2]);
  let eh = Number(e![1]);
  const em = Number(e![2]);
  if (sm !== 0) fail(`Slots start on the hour (09:00, 10:00, …); "${start}" does not.`);
  if (em === 50) eh += 1;
  else if (em !== 0) fail(`Slots end on the hour or at :50 (e.g. 16:00 or 15:50); "${end}" does not.`);
  if (sh > 23 || eh > 24) fail(`"${start}"–"${end}" is not a time of day.`);
  if (eh <= sh) fail(`The end (${end}) must be after the start (${start}).`);
  const out: string[] = [];
  for (let h = sh; h < eh; h++) out.push(String(h).padStart(2, "0"));
  return out;
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** Everything the page would check, plus that each slot is still free. Returns the slots to book. */
export function checkBooking(req: BookingRequest, today: string, room: RoomInfo, free: Slot[]): Slot[] {
  checkDate(req.date, today);
  const hours = hoursFor(req.start, req.end);

  const limit = Math.min(room.maxHours, CAMPUS_MAX_HOURS);
  if (hours.length > limit) {
    fail(`${room.name} can be booked for at most ${limit} hour${limit === 1 ? "" : "s"} at a time; ${req.start}–${req.end} is ${hours.length}.`);
  }
  if (room.minHours && hours.length < room.minHours) fail(`${room.name} must be booked for at least ${room.minHours} hours.`);

  const outside = hours.filter((h) => Number(h) < room.openFrom || Number(h) + 1 > room.openUntil);
  if (outside.length) {
    fail(`${room.name} is bookable ${String(room.openFrom).padStart(2, "0")}:00–${String(room.openUntil).padStart(2, "0")}:00; ${outside.map((h) => `${h}:00`).join(", ")} is outside that.`);
  }

  const byHour = new Map(free.map((s) => [s.hour, s]));
  const taken = hours.filter((h) => !byHour.has(h));
  if (taken.length) {
    const open = free.map((s) => s.start).join(", ") || "none";
    fail(`${room.name} is not free on ${req.date} at ${taken.map((h) => `${h}:00`).join(", ")}. Free slots that day start at: ${open}.`);
  }

  if (!Number.isInteger(req.attendees) || req.attendees < 1 || req.attendees > 999) fail(`Attendees must be a whole number from 1 to 999; got ${req.attendees}.`);
  if (req.attendees > room.capacity) fail(`${room.name} holds ${room.capacity}; ${req.attendees} attendees is over capacity (the page: "세미나실 정원을 초과하여 신청할 수 없습니다").`);

  if (!req.eventName.trim()) fail("An event name (행사명) is required.");
  if (!req.groupName.trim()) fail("A group name (단체명) is required.");
  if (bytes(req.eventName) > 200) fail(`The event name is ${bytes(req.eventName)} bytes; the page allows 200.`);
  if (bytes(req.groupName) > 500) fail(`The group name is ${bytes(req.groupName)} bytes; the page allows 500.`);

  return hours.map((h) => byHour.get(h)!);
}

/**
 * Dormitory seminar / dance / band room tools for the Songdo (International
 * Campus) dormitory, on the Yonsei Portal's academic system:
 * 학사행정 → 기숙사 → "세미나실, 댄스/밴드연습실 예약".
 *
 * Booking and cancelling have side effects, so both take `confirm` and do
 * everything but the final submit until it is `true`. After a submit, the
 * answer is what the portal's own reservation list shows, not what the request
 * said it would do.
 *
 * The Sinchon dormitories (기숙사(신촌) → 세미나실예약) are a separate page and
 * program (ndomap2400) that this tool does not cover: it could not be inspected,
 * because the account it was built with is not eligible there.
 */
import { z } from "zod";
import { tool, type ToolDefinition, type ToolResult } from "../mcp.js";
import { addDays, isRealDate } from "../time.js";
import { EVENT_KINDS, SeminarRoomError, type BuildingCode, type EventKind } from "./parse.js";
import { portalTransport } from "./portal.js";
import { SeminarRooms, type Deps } from "./service.js";

const PAGE = "Yonsei Portal → 학사정보시스템 (학사행정) → 기숙사 → 세미나실, 댄스/밴드연습실 예약";

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

function failure(err: unknown): ToolResult {
  if (err instanceof SeminarRoomError) {
    const hint: Record<string, string> = {
      session: "Sign in again with `node dist/server.js login` if this repeats.",
      program: `The page may have moved. Check it by hand: ${PAGE}.`,
      layout: `The portal's answer changed shape; this tool needs updating. Check by hand: ${PAGE}.`,
      rejected: "",
      not_eligible: "",
      invalid: "",
    };
    return text([err.message, hint[err.kind]].filter(Boolean).join("\n"), true);
  }
  return text(`Could not reach the Yonsei academic portal: ${err instanceof Error ? err.message : String(err)}`, true);
}

const BUILDING_ARG = { songdo1: "S11", songdo2: "S21" } as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const time = z.string().regex(/^\d{1,2}:\d{2}$/, "HH:MM");

const RULES = `Rules the page applies (Songdo): no same-day booking; at most 5 days ahead; one-hour
slots (HH:00–HH:50) within each room's hours (09:00–24:00 for the rooms seen); at most 4 hours per
booking (and the room's own maximum); attendees no more than the room's capacity; event name,
group name, event kind and attendee count are required. A reservation can be cancelled while its
date is today or later. Any further limit (per day/week, penalties) is the portal's to enforce:
its refusal is returned word for word.`;

export function seminarRoomTools(deps: Deps = { transport: portalTransport }): ToolDefinition<any>[] {
  const svc = new SeminarRooms(deps);

  return [
    tool(
      "seminar_room_availability",
      `Free and taken time slots of the Songdo dormitory's seminar rooms and dance/band practice
rooms (송도1학사 / 송도2학사), for one date or several days. Read-only.

Reads the Yonsei Portal's own reservation page live (needs the Yonsei login). Each room is listed
with capacity, maximum hours, and its free and taken hours. Dates outside the bookable window are
shown but marked viewing-only.

Use this when: the user wants a study/meeting room, asks what is free, or before booking.
For booking use seminar_room_book. Only the Songdo (International Campus) dormitory is covered —
the Sinchon dormitories' seminar-room page is separate and not supported.

${RULES}`,
      {
        date: date.optional().describe("YYYY-MM-DD, Seoul. Default: tomorrow (the first bookable day)."),
        days: z.number().int().min(1).max(7).optional().describe("How many days from `date` (default 1)."),
        building: z.enum(["songdo1", "songdo2"]).optional().describe("송도1학사 or 송도2학사. Default: both."),
        room: z.string().optional().describe('One room, by code or name number, e.g. "C0102" or "B138".'),
      },
      async (args) => {
        try {
          const start = args.date ?? addDays(svc.today(), 1);
          if (!isRealDate(start)) return text(`"${start}" is not a date; use YYYY-MM-DD.`, true);
          return text(
            await svc.availability({
              date: start,
              days: args.days ?? 1,
              building: args.building ? (BUILDING_ARG[args.building] as BuildingCode) : undefined,
              room: args.room,
            })
          );
        } catch (err) {
          return failure(err);
        }
      }
    ),

    tool(
      "seminar_room_my_reservations",
      `The user's Songdo dormitory seminar/practice-room reservations from the Yonsei Portal:
date, room, booked hours, status (신청 applied, 승인 approved, 배정 assigned, 취소 cancelled,
반려 rejected with the reason), event and group. Read-only. Each has a reservation number, which
seminar_room_cancel takes.

Use this when: the user asks what they have booked, whether a booking was approved, or wants to
cancel one.`,
      {
        include_past: z.boolean().optional().describe("Also list reservations whose date has passed (default false)."),
        limit: z.number().int().min(1).max(50).optional().describe("At most this many (default 15)."),
      },
      async (args) => {
        try {
          return text(await svc.myReservations({ includePast: Boolean(args.include_past), limit: args.limit ?? 15 }));
        } catch (err) {
          return failure(err);
        }
      }
    ),

    tool(
      "seminar_room_book",
      `Book a Songdo dormitory seminar room or dance/band practice room on the Yonsei Portal.
SIDE EFFECT: creates a real reservation in the user's name.

Two steps, always:
1. Call with confirm omitted or false. Nothing is submitted: every rule is checked against the
   live page and the answer is a PREVIEW (room, date, time, event, approval) — or a specific reason
   it cannot be booked.
2. Show that preview to the user and get an explicit yes. Only then call again with the same
   arguments and confirm: true. Never set confirm: true on your own initiative.

After submitting, the answer is what the portal's reservation list then shows.

${RULES}`,
      {
        date: date.describe("YYYY-MM-DD, Seoul. Tomorrow at the earliest, at most 5 days ahead."),
        room: z.string().describe('Room code or name number, e.g. "C0102" or "B138" (see seminar_room_availability).'),
        start: time.describe('Start, on the hour, e.g. "14:00".'),
        end: time.describe('End, on the hour or at :50, e.g. "16:00" (= slots 14:00 and 15:00).'),
        event_name: z.string().min(1).describe("행사명 — what the room is for, e.g. \"Study group\"."),
        group_name: z.string().min(1).describe("단체명 — the group or club booking it; the user's name or study group is fine."),
        event_kind: z
          .enum(Object.keys(EVENT_KINDS) as [EventKind, ...EventKind[]])
          .describe("행사종류: lecture (강의), exam (시험), camp (캠프), meeting (회의), seminar (세미나) or other (기타)."),
        attendees: z.number().int().min(1).max(999).describe("행사인원 — number of people; no more than the room's capacity."),
        confirm: z.boolean().optional().describe("false/omitted = preview only. true = submit; only after the user said yes to the preview."),
      },
      async (args) => {
        try {
          const r = await svc.book({
            date: args.date,
            room: args.room,
            start: args.start,
            end: args.end,
            eventName: args.event_name,
            groupName: args.group_name,
            eventKind: args.event_kind,
            attendees: args.attendees,
            confirm: args.confirm === true,
          });
          return text(r.text);
        } catch (err) {
          return failure(err);
        }
      }
    ),

    tool(
      "seminar_room_cancel",
      `Cancel one of the user's Songdo dormitory seminar/practice-room reservations on the Yonsei
Portal. SIDE EFFECT: the reservation is cancelled and the slot is released.

Two steps, always:
1. Call with the reservation number (from seminar_room_my_reservations) and confirm omitted or
   false. Nothing is cancelled; the answer is a PREVIEW of the reservation, or why it cannot be
   cancelled (already cancelled, rejected, or its date has passed).
2. Show that preview to the user and get an explicit yes. Only then call again with confirm: true.

After submitting, the answer is the reservation's status as the portal then shows it.`,
      {
        reservation_number: z.string().min(1).describe("The number seminar_room_my_reservations shows after #."),
        confirm: z.boolean().optional().describe("false/omitted = preview only. true = cancel; only after the user said yes to the preview."),
      },
      async (args) => {
        try {
          const r = await svc.cancel({ number: args.reservation_number, confirm: args.confirm === true });
          return text(r.text);
        } catch (err) {
          return failure(err);
        }
      }
    ),
  ];
}

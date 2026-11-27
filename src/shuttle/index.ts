/**
 * Shuttle tools: the Songdo (International) ⇄ Sinchon campus bus.
 *
 * Public data, so these need no login and no browser. The timetable comes from
 * Yonsei's own notices; every answer names the notice it came from so the
 * reader can check it. They cannot see public holidays, and they do not make
 * reservations — seats are booked on the Yonsei Portal.
 */
import { z } from "zod";
import { tool, type ToolDefinition, type ToolResult } from "../mcp.js";
import { ShuttleParseError, type Departure, type ShuttleTimetable } from "./parse.js";
import { isWeekend, minutes, nextDepartures, parseAt, seoulTime, timetableFor, type Origin } from "./schedule.js";

const OFFICIAL_PAGE = "https://www.yonsei.ac.kr/sc/364/subview.do";
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const NAME: Record<Origin, string> = { sinchon: "Sinchon → Songdo", songdo: "Songdo → Sinchon" };

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

const label = (d: Departure) =>
  `${d.time}${d.vehicle ? `  ${d.vehicle}` : ""}${d.accessible ? " (wheelchair-accessible)" : ""}${d.marked ? " *" : ""}`;

function source(t: ShuttleTimetable, staleSince?: string): string {
  return [
    `Source: ${t.title} — posted ${t.postedDate ?? "?"}, valid ${t.periodStart} to ${t.periodEnd}`,
    t.url,
    staleSince ? `⚠ yonsei.ac.kr could not be reached; this is cached data from ${staleSince}.` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function rules(t: ShuttleTimetable): string {
  return [
    t.noWeekendOrHolidayService
      ? "No service on Saturdays, Sundays or public holidays (public holidays are not checked by this tool)."
      : "The notice does not say whether weekends and holidays run; this tool assumes no weekend service.",
    t.tripMinutes ? `The trip takes about ${Math.floor(t.tripMinutes / 60)}h${t.tripMinutes % 60 ? ` ${t.tripMinutes % 60}min` : ""}; traffic can delay it.` : null,
    "Seats are reserved: Yonsei Portal (portal.yonsei.ac.kr) → IT서비스 → 국제캠퍼스 셔틀버스 예약. Show the reservation receipt or text message with your ID. Reserved riders board until the departure minute; others may board after.",
    [...t.fromSinchon, ...t.fromSongdo].some((d) => d.marked)
      ? "* The notice marks this time with an asterisk but does not say why; check the notice before relying on it."
      : null,
    "Times can change in emergencies (weather, accidents, demonstrations).",
  ]
    .filter(Boolean)
    .join("\n");
}

/** A lookup that failed for a reason the caller can act on, with the official link. */
function failure(err: unknown): ToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  const hint =
    err instanceof ShuttleParseError
      ? "Yonsei's notice no longer matches what this tool expects."
      : "yonsei.ac.kr could not be reached and nothing is cached.";
  return text(`${hint}\n${msg}\nCheck the official timetable: ${OFFICIAL_PAGE}`, true);
}

export function shuttleTools(): ToolDefinition<any>[] {
  return [
    tool(
      "shuttle_next",
      `When the next Yonsei inter-campus shuttle leaves — Sinchon ⇄ Songdo (International Campus).

Reads Yonsei's published timetable (public; no login) and answers in Seoul time. Skips
weekends. Omit \`from\` to get both directions. The answer names the notice it used, its
period and link, so you can cite it.

Use this when: the user asks when the bus leaves, whether they can still catch one, or how
to get between campuses. Seats must be reserved on the Yonsei Portal — this tool cannot do that.`,
      {
        from: z.enum(["sinchon", "songdo"]).optional().describe("Where the user boards. Omit for both directions."),
        count: z.number().int().min(1).max(10).optional().describe("Departures per direction (default 3)."),
        at: z.string().optional().describe("Pretend it is this moment, Seoul time, like 2026-12-01T08:30. Default: now."),
        refresh: z.boolean().optional().describe("Re-read Yonsei's site instead of the cache."),
      },
      async (args) => {
        try {
          const now = parseAt(args.at);
          const s = seoulTime(now);
          const origins: Origin[] = args.from ? [args.from] : ["sinchon", "songdo"];
          const blocks: string[] = [`Now: ${WEEKDAYS[s.weekday]} ${s.date} ${s.time} (Seoul)`];
          let used: ShuttleTimetable | null = null;
          let stale: string | undefined;

          for (const origin of origins) {
            const r = await nextDepartures(origin, now, args.count ?? 3, args.refresh);
            stale ??= r.staleSince;
            const lines = r.departures.map((u) => {
              used = u.timetable;
              const when =
                u.date === s.date
                  ? `today, in ${minutes(u.departure.time) - minutes(s.time)} min`
                  : `${WEEKDAYS[new Date(`${u.date}T00:00:00Z`).getUTCDay()]} ${u.date}`;
              return `- ${label(u.departure)}  — ${when}`;
            });
            if (!lines.length) lines.push("- (none found)");
            if (r.skipped.length) lines.push(`  (no service ${r.skipped.join(", ")}: weekend)`);
            if (r.stopped) lines.push(`  (stopped: ${r.stopped} — a new timetable may not be posted yet)`);
            blocks.push(`${NAME[origin]}\n${lines.join("\n")}`);
          }
          const t: ShuttleTimetable | null = used;
          return text(
            [blocks.join("\n\n"), t ? `${source(t, stale)}\n\n${rules(t)}` : `Official page: ${OFFICIAL_PAGE}`].join("\n\n")
          );
        } catch (err) {
          return failure(err);
        }
      }
    ),

    tool(
      "shuttle_timetable",
      `The full Yonsei inter-campus shuttle timetable (Sinchon ⇄ Songdo) for a date.

Picks the published notice whose service period covers the date (semester or vacation
timetable) and returns every departure with its vehicle. Public data; no login.

Use this when: the user wants the whole day's schedule, or the schedule for a particular
date such as a vacation week. For "when is the next one" use shuttle_next.`,
      {
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, Seoul. Default: today."),
        direction: z.enum(["sinchon_to_songdo", "songdo_to_sinchon", "both"]).optional().describe("Default both."),
        refresh: z.boolean().optional().describe("Re-read Yonsei's site instead of the cache."),
      },
      async (args) => {
        try {
          const date = args.date ?? seoulTime(new Date()).date;
          const pick = await timetableFor(date, args.refresh);
          if (pick.kind === "none") {
            return text(
              `No published shuttle timetable covers ${date}.` +
                (pick.latest ? ` The latest one found is "${pick.latest.title}", valid ${pick.latest.periodStart} to ${pick.latest.periodEnd} (${pick.latest.url}).` : "") +
                `\nThe next timetable may not be posted yet. Official page: ${OFFICIAL_PAGE}`
            );
          }
          const t = pick.timetable;
          const dir = args.direction ?? "both";
          const parts: string[] = [];
          if (isWeekend(date)) parts.push(`${date} is a weekend — the shuttle does not run. This is the weekday timetable:`);
          if (dir !== "songdo_to_sinchon") {
            parts.push(`${NAME.sinchon}${t.routeFromSinchon ? `\n(${t.routeFromSinchon})` : ""}\n${t.fromSinchon.map((d) => `- ${label(d)}`).join("\n")}`);
          }
          if (dir !== "sinchon_to_songdo") {
            parts.push(`${NAME.songdo}${t.routeFromSongdo ? `\n(${t.routeFromSongdo})` : ""}\n${t.fromSongdo.map((d) => `- ${label(d)}`).join("\n")}`);
          }
          parts.push(`${source(t, pick.staleSince)}\n\n${rules(t)}`);
          return text(parts.join("\n\n"));
        } catch (err) {
          return failure(err);
        }
      }
    ),
  ];
}

/**
 * Parsers for the Songdo dormitory's seminar / dance / band room reservation
 * page (학사행정 → 기숙사 → "세미나실, 댄스/밴드연습실 예약", program sdombk0200).
 *
 * The page talks to `/sch/sdom/SdombkCtr/*.do`, which answer JSON. A good
 * answer is `{ "<dataset>": [rows…] }`; a refusal is
 * `{ "_METADATA_": { success: false, msg: "<code or text>", params } }` —
 * with HTTP 200 either way, including when the session has expired. So the
 * status code says nothing: every answer is checked for the dataset it should
 * carry, and anything else is an error that says what was expected and found.
 *
 * Fields are read by name (the page's own column ids), never by position.
 */

export type ErrorKind =
  | "session" // signed out / SSO lapsed
  | "program" // the menu or program ids no longer match the site
  | "layout" // the answer is not shaped like it was when this was written
  | "rejected" // the portal refused the request and said why
  | "not_eligible" // the account may not use this page
  | "invalid"; // the request broke a rule before anything was sent

export class SeminarRoomError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string
  ) {
    super(message);
    this.name = "SeminarRoomError";
  }
}

/** Message ids the portal returns, with the text its own message table shows for them. */
const MESSAGES: Record<string, string> = {
  "P000000-0007": "조회된 데이터가 없습니다. (no data found)",
  "P000000-0010": "생성되었습니다. (created)",
  "P000000-0020": "프로그램 정보를 찾을 수 없습니다. (program information not found)",
  "P000000-0025": "신청되었습니다. (application submitted)",
  "P000000-0096": "{0}이(가) 존재하지 않습니다. ({0} does not exist)",
};

export function describeMessage(msg: string, params?: unknown): string {
  let list: string[] = [];
  if (typeof params === "string") {
    try {
      const p = JSON.parse(params);
      if (Array.isArray(p)) list = p.map(String);
    } catch {
      list = [params];
    }
  } else if (Array.isArray(params)) list = params.map(String);
  const template = MESSAGES[msg];
  const fill = (t: string) => t.replace(/\{(\d+)\}/g, (_, i) => list[Number(i)] ?? "?");
  if (template) return `${fill(template)} [${msg}]`;
  return list.length ? `${msg} (${list.join(", ")})` : msg;
}

interface Metadata {
  success?: boolean | string;
  msg?: string;
  params?: unknown;
  code?: number;
}

const snippet = (s: string, n = 160) => s.replace(/\s+/g, " ").trim().slice(0, n);

/** The portal's way of saying "you are not signed in", in any of the shapes seen. */
export function looksSignedOut(text: string): boolean {
  return /SSO 인증정보가 없습니다|PmSSOService|infra\.yonsei\.ac\.kr\/sso|SSOLegacy\.do\?pname=spLogout|로그인 정보이\(가\) 존재하지 않습니다/.test(text);
}

function metadataError(where: string, m: Metadata): SeminarRoomError {
  const msg = String(m.msg ?? "");
  const text = describeMessage(msg, m.params);
  if (msg === "P000000-0096") {
    return new SeminarRoomError("session", `The Yonsei Portal session has expired (${where} answered: ${text}).`);
  }
  if (msg === "P000000-0020") {
    return new SeminarRoomError(
      "program",
      `The portal no longer recognises this tool's menu/program ids (${where} answered: ${text}). The seminar-room page has probably moved in the menu; this tool needs updating.`
    );
  }
  return new SeminarRoomError("rejected", `The portal refused the request (${where}): ${text || "no reason given"}.`);
}

function parseJson(where: string, text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    if (looksSignedOut(trimmed)) {
      throw new SeminarRoomError("session", `The Yonsei Portal session has expired: ${where} returned the SSO sign-in page instead of data.`);
    }
    const title = trimmed.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
    throw new SeminarRoomError(
      "layout",
      `Expected JSON from ${where}, got ${trimmed.startsWith("<") ? `an HTML page${title ? ` titled "${title}"` : ""}` : "text"}: "${snippet(trimmed)}".`
    );
  }
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    throw new SeminarRoomError("layout", `${where} returned malformed JSON: "${snippet(trimmed)}".`);
  }
}

/** Rows of `key` from a read endpoint, or a specific error. An empty array is a real answer. */
export function parseRows(where: string, text: string, key: string): Array<Record<string, unknown>> {
  const json = parseJson(where, text);
  const meta = json._METADATA_ as Metadata | undefined;
  if (meta && String(meta.success) === "false") throw metadataError(where, meta);
  if (!(key in json)) {
    if (looksSignedOut(text)) throw new SeminarRoomError("session", `The Yonsei Portal session has expired (${where}).`);
    throw new SeminarRoomError("layout", `Expected "${key}" in the answer from ${where}; found ${Object.keys(json).map((k) => `"${k}"`).join(", ") || "nothing"}.`);
  }
  const rows = json[key];
  if (!Array.isArray(rows)) throw new SeminarRoomError("layout", `Expected "${key}" from ${where} to be a list; got ${typeof rows}.`);
  return rows as Array<Record<string, unknown>>;
}

/** A write endpoint (book / cancel): success unless the portal says otherwise. */
export function parseWriteResult(where: string, text: string): { message: string | null } {
  if (!text.trim()) return { message: null };
  const json = parseJson(where, text);
  const meta = json._METADATA_ as Metadata | undefined;
  if (meta && String(meta.success) === "false") throw metadataError(where, meta);
  return { message: meta?.msg ? describeMessage(String(meta.msg), meta.params) : null };
}

/* -------------------------------------------------------------- fields --- */

function need(where: string, row: Record<string, unknown>, field: string): string {
  const v = row[field];
  if (v === null || v === undefined || v === "") {
    throw new SeminarRoomError("layout", `Expected "${field}" in every row from ${where}; a row has none (fields present: ${Object.keys(row).join(", ")}).`);
  }
  return String(v);
}

function needNumber(where: string, row: Record<string, unknown>, field: string): number {
  const n = Number(need(where, row, field));
  if (!Number.isFinite(n)) throw new SeminarRoomError("layout", `Expected "${field}" from ${where} to be a number; got "${row[field]}".`);
  return n;
}

const opt = (row: Record<string, unknown>, field: string) => {
  const v = row[field];
  return v === null || v === undefined || v === "" ? null : String(v);
};
const optNumber = (row: Record<string, unknown>, field: string) => {
  const v = opt(row, field);
  return v === null || !Number.isFinite(Number(v)) ? null : Number(v);
};

/* -------------------------------------------------------------- models --- */

export const BUILDINGS = {
  S11: "송도1학사 (Songdo Dorm 1)",
  S21: "송도2학사 (Songdo Dorm 2)",
} as const;
export type BuildingCode = keyof typeof BUILDINGS;

/** 행사종류 (SDOM0330), as the page's code table lists them. */
export const EVENT_KINDS = {
  lecture: { code: "10", label: "강의 (lecture)" },
  exam: { code: "20", label: "시험 (exam)" },
  camp: { code: "30", label: "캠프 (camp)" },
  meeting: { code: "40", label: "회의 (meeting)" },
  seminar: { code: "50", label: "세미나 (seminar)" },
  other: { code: "60", label: "기타 (other)" },
} as const;
export type EventKind = keyof typeof EVENT_KINDS;

/** 신청상태 (SDOM0310). */
export const STATUSES: Record<string, string> = {
  "10": "작성 (draft)",
  "20": "신청 (applied, awaiting approval)",
  "30": "승인 (approved)",
  "40": "배정 (assigned)",
  "90": "취소 (cancelled)",
  "99": "반려 (rejected)",
};
export const statusLabel = (code: string | null) => (code ? STATUSES[code] ?? `status ${code}` : "unknown status");

export interface Room {
  code: string;
  name: string;
  building: string;
  capacity: number;
  maxHours: number;
  /** Rooms marked for immediate approval are booked as 승인 straight away; others wait as 신청. */
  immediateApproval: boolean;
  /** `imdtlAprvlYn` exactly as listed; the page sends it back unchanged when booking. */
  approvalFlag: string;
  campus: string;
}

export function parseRooms(text: string): Room[] {
  const where = "the room list (findBkblSemrmList)";
  return parseRows(where, text, "dsSdom430").map((r) => ({
    code: need(where, r, "semrmCd"),
    name: need(where, r, "semrmNm"),
    building: need(where, r, "dormtBuldDivCd"),
    capacity: needNumber(where, r, "percpCnt"),
    maxHours: needNumber(where, r, "maxUseHcnt"),
    immediateApproval: opt(r, "imdtlAprvlYn") === "1",
    approvalFlag: opt(r, "imdtlAprvlYn") ?? "",
    campus: need(where, r, "campsDivCd"),
  }));
}

export interface RoomInfo {
  code: string;
  name: string;
  englishName: string | null;
  building: string;
  capacity: number;
  minPeople: number | null;
  maxPeople: number | null;
  minHours: number | null;
  maxHours: number;
  /** First bookable hour and the hour bookings must end by, e.g. 9 and 24. */
  openFrom: number;
  openUntil: number;
  remark: string | null;
  inUse: boolean;
}

export function parseRoomInfo(text: string): RoomInfo {
  const where = "the room details (findSdomSemRmList)";
  const rows = parseRows(where, text, "dsSdom430");
  if (rows.length !== 1) throw new SeminarRoomError("layout", `Expected one room from ${where}; got ${rows.length}.`);
  const r = rows[0];
  const remark = [opt(r, "engRemrk"), opt(r, "remrk")].filter(Boolean).join(" / ") || null;
  return {
    code: need(where, r, "semrmCd"),
    name: need(where, r, "semrmNm"),
    englishName: opt(r, "semrmEngNm"),
    building: need(where, r, "dormtBuldDivCd"),
    capacity: needNumber(where, r, "percpCnt"),
    minPeople: optNumber(r, "minPcnt"),
    maxPeople: optNumber(r, "maxPcnt"),
    minHours: optNumber(r, "minUseHcnt"),
    maxHours: needNumber(where, r, "maxUseHcnt"),
    openFrom: needNumber(where, r, "useBeginTimeDivCd"),
    openUntil: needNumber(where, r, "useEndTimeDivCd"),
    remark,
    inUse: opt(r, "useYn") !== "0",
  };
}

export interface Slot {
  /** The page's slot code: the starting hour, `09`…`23`. */
  hour: string;
  start: string; // HH:MM
  end: string; // HH:MM
  label: string; // as the page shows it, "10:00 ~ 10:50"
}

/** Free slots of one room on one day. The portal lists only what is still bookable. */
export function parseSlots(text: string): Slot[] {
  const where = "the time slots (findBkblSemrmPlanList)";
  return parseRows(where, text, "dsSdom430Pl").map((r) => {
    const hour = need(where, r, "useBeginTimeDivCd");
    const label = need(where, r, "fullNm");
    const m = label.match(/(\d{1,2}):(\d{2})\s*~\s*(\d{1,2}):(\d{2})/);
    if (!/^\d{2}$/.test(hour) || !m) {
      throw new SeminarRoomError("layout", `Expected a slot like "10" / "10:00 ~ 10:50" from ${where}; got "${hour}" / "${label}".`);
    }
    return { hour, start: `${m[1].padStart(2, "0")}:${m[2]}`, end: `${m[3].padStart(2, "0")}:${m[4]}`, label };
  });
}

export interface Eligibility {
  eligible: boolean;
  campus: string | null;
  /** Needed in the booking request; never shown or logged. */
  studentNo: string | null;
}

/** `findSemrmResveAplyInit`: one row when the account may book here, none when it may not. */
export function parseInit(text: string): Eligibility {
  const where = "the page set-up (findSemrmResveAplyInit)";
  const rows = parseRows(where, text, "dsSdom450");
  if (rows.length === 0) return { eligible: false, campus: null, studentNo: null };
  return { eligible: true, campus: need(where, rows[0], "campsDivCd"), studentNo: need(where, rows[0], "stuno") };
}

export interface Reservation {
  number: string;
  date: string; // YYYY-MM-DD
  roomCode: string;
  roomName: string | null;
  eventName: string | null;
  groupName: string | null;
  eventKind: string | null;
  people: number | null;
  status: string | null;
  rejectReason: string | null;
  /** Booked slots as the portal lists them; only the detail call carries them. */
  times: string[] | null;
}

const isoDate = (where: string, yyyymmdd: string) => {
  const m = yyyymmdd.match(/^(\d{4})(\d{2})(\d{2})$/) ?? yyyymmdd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new SeminarRoomError("layout", `Expected a date like 20261128 from ${where}; got "${yyyymmdd}".`);
  return `${m[1]}-${m[2]}-${m[3]}`;
};

/** The detail's `useBeginTimeDivCd` holds the booked hours; accept "10:00 ~ 10:50" text or bare hour codes. */
export function parseTimes(raw: string | null): string[] | null {
  if (!raw) return null;
  const ranges = [...raw.matchAll(/(\d{1,2}):(\d{2})\s*~\s*(\d{1,2}):(\d{2})/g)].map(
    (m) => `${m[1].padStart(2, "0")}:${m[2]}–${m[3].padStart(2, "0")}:${m[4]}`
  );
  if (ranges.length) return ranges;
  const hours = raw.match(/\b\d{2}\b/g);
  if (hours && hours.every((h) => Number(h) <= 24)) return hours.map((h) => `${h}:00–${h}:50`);
  return [raw.trim()];
}

function toReservation(where: string, r: Record<string, unknown>): Reservation {
  return {
    number: need(where, r, "semrmResveNo"),
    date: isoDate(where, need(where, r, "resveDt")),
    roomCode: need(where, r, "semrmCd"),
    roomName: opt(r, "semrmNm"),
    eventName: opt(r, "evntNm"),
    groupName: opt(r, "evntPrgrsGrpNm"),
    eventKind: opt(r, "evntKindDivCd"),
    people: optNumber(r, "evntPcnt"),
    status: opt(r, "aplySttusDivCd"),
    rejectReason: opt(r, "returResnCtnt"),
    times: "useBeginTimeDivCd" in r ? parseTimes(opt(r, "useBeginTimeDivCd")) : null,
  };
}

export function parseReservations(text: string): Reservation[] {
  const where = "the reservation list (findSemrmResveAplyList)";
  return parseRows(where, text, "dsSdom450").map((r) => toReservation(where, r));
}

export function parseReservationDetail(text: string, number: string): Reservation {
  const where = `reservation ${number} (findSemrmResveAplyList)`;
  const rows = parseRows(where, text, "dsSdom450");
  const row = rows.find((r) => String(r.semrmResveNo) === number);
  if (!row) {
    throw new SeminarRoomError("rejected", rows.length ? `The portal returned a different reservation than ${number}.` : `Reservation ${number} was not found on the portal.`);
  }
  return toReservation(where, row);
}

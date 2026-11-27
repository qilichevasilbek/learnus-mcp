/**
 * The request format of Yonsei's academic system (underwood1.yonsei.ac.kr,
 * "학사행정"), as observed from its own page script while signed in.
 *
 * The pages are eXBuilder6 (cpr) apps. Every call is a form-urlencoded POST:
 *
 *   _menuId=<enc>&_menuNm=<name>&_pgmId=<enc>          — which menu/program is asking
 *   @d1#field=value&…&@d#=@d1#&@d1#=<alias>&@d1#tp=dm   — a DataMap (search conditions)
 *   @d2#col=v&@d2#sts=i&…&@d#=@d2#&@d2#=<alias>&@d2#tp=ds — a DataSet, one block per row
 *
 * Without the menu/program ids the server answers `P000000-0020` ("program
 * information not found"). The ids are the menu's numbers run through the
 * page's own arithmetic (`_encodeMenuId`/`_encodePgmId` in the portal's
 * user-modules.js); the results below were checked against the live page.
 */

/** Pure functions only — no network here, so tests can pin the exact bytes. */

export function encodeMenuId(menuId: string): string {
  let n = Number(menuId.replace("M", ""));
  n = (n * 3 + 46) * 7;
  n = n * n * n + 78;
  return Buffer.from(String(n)).toString("base64");
}

export function encodePgmId(pgmId: string): string {
  let n = Number(pgmId.replace("P", ""));
  n = (n * 5 + 48) * 9;
  n = n * n + 782;
  return Buffer.from(String(n)).toString("base64");
}

export interface Menu {
  menuId: string;
  pgmId: string;
  menuNm: string;
}

type Value = string | number | null | undefined;
type Pair = [string, string];

const str = (v: Value) => (v === null || v === undefined ? "" : String(v));

function menuPairs(menu: Menu): Pair[] {
  return [
    ["_menuId", encodeMenuId(menu.menuId)],
    ["_menuNm", menu.menuNm],
    ["_pgmId", encodePgmId(menu.pgmId)],
  ];
}

/** A cpr DataMap: one record of search conditions. */
export function dataMap(n: number, alias: string, fields: Record<string, Value>): Pair[] {
  const p = `@d${n}#`;
  return [
    ...Object.entries(fields).map(([k, v]): Pair => [`${p}${k}`, str(v)]),
    ["@d#", p],
    [p, alias],
    [`${p}tp`, "dm"],
  ];
}

/** A cpr DataSet of inserted rows (`sts=i`), columns in the order given. */
export function dataSet(n: number, alias: string, columns: string[], rows: Array<Record<string, Value>>): Pair[] {
  const p = `@d${n}#`;
  const out: Pair[] = [];
  for (const row of rows) {
    for (const c of columns) out.push([`${p}${c}`, str(row[c])]);
    out.push([`${p}sts`, "i"]);
  }
  out.push(["@d#", p], [p, alias], [`${p}tp`, "ds"]);
  return out;
}

/** The final body: menu ids first, then each block, `&`-terminated like the page sends it. */
export function encodeBody(menu: Menu, ...blocks: Pair[][]): string {
  return [...menuPairs(menu), ...blocks.flat()].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&") + "&";
}

/** Plain parameters (the page's `args:`), e.g. the cancel call. */
export function encodeArgs(menu: Menu, args: Record<string, Value>): string {
  const pairs: Pair[] = [...Object.entries(args).map(([k, v]): Pair => [k, str(v)]), ...menuPairs(menu)];
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&") + "&";
}

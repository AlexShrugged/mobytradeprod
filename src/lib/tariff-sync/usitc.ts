// USITC HTS REST fetchers (hts.usitc.gov/reststop — unauthenticated).
// exportList always serves the CURRENT published schedule; release ids are
// labels, so a skipped release simply means the next diff spans two
// releases (safe: the differ always compares against live state).
//
// releaseList quirks (legacy-verified): entries are NOT chronologically
// ordered and their shape has drifted — select status === "current", never
// the last element (the literal last entry is an ancient 2015 edition).

import { normalizeHts } from "../duty/calculator";
import type { BaseScheduleRow, Ch99Row } from "./types";

const BASE = "https://hts.usitc.gov/reststop";
const TIMEOUT_MS = 120_000;

export type HtsRelease = {
  id: string;
  name: string;
  /** The release's start date from releaseList (releaseStartDate, falling
   *  back to the created date) — the default effective date for base-window
   *  tiling. Null when the descriptor carries neither. */
  effectiveDate: string | null;
};

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`USITC ${res.status} for ${url}`);
  }
  return res.json();
}

export async function latestRelease(): Promise<HtsRelease> {
  const raw = await getJson(`${BASE}/releaseList`);
  if (!Array.isArray(raw)) throw new Error("USITC releaseList: not an array");

  const entries = raw.filter(
    (r): r is Record<string, unknown> => typeof r === "object" && r !== null,
  );
  const current =
    entries.find((r) => r.status === "current") ??
    entries.find((r) => r.current === true);
  const picked = current ?? entries[entries.length - 1];
  if (!picked) throw new Error("USITC releaseList: no usable entries");

  const id = String(picked.name ?? picked.id ?? picked.release ?? "unknown");
  return {
    id,
    name: String(picked.name ?? id),
    effectiveDate:
      mdyToIso(picked.releaseStartDate) ?? mdyToIso(picked.date) ?? null,
  };
}

/** releaseList dates arrive as "07/31/2026". */
function mdyToIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

export async function fetchChapter99(): Promise<{ rows: Ch99Row[]; raw: unknown }> {
  const raw = await getJson(
    `${BASE}/exportList?from=9901&to=9999&format=JSON&styles=false`,
  );
  return { rows: parseCh99Rows(raw), raw };
}

/** Pure: normalize the exportList payload into Ch99Rows. Keeps only
 *  8-digit 9903.xx.xx measure lines (statistical suffixes and headings
 *  carry no rate of their own). */
export function parseCh99Rows(raw: unknown): Ch99Row[] {
  const out: Ch99Row[] = [];
  for (const row of exportListRows(raw)) {
    const htsno = typeof row.htsno === "string" ? row.htsno.trim() : "";
    if (!/^9903\.\d{2}\.\d{2}$/.test(htsno)) continue;
    out.push({
      htsno,
      digits: normalizeHts(htsno),
      description: str(row.description),
      general: str(row.general),
      special: str(row.special),
      additionalDuties: str(row.additional_duties ?? row.additionalDuties),
      footnotes: str(row.footnotes),
    });
  }
  return out;
}

/** The full base schedule, chapters 1–97 (heading bounds 0101..9799).
 *  Chapters 98/99 are special-classification and trade-measure provisions —
 *  the Chapter 99 pull above owns those, so the ranges never collide. */
export async function fetchBaseSchedule(): Promise<{
  rows: BaseScheduleRow[];
  raw: unknown;
}> {
  const raw = await getJson(
    `${BASE}/exportList?from=0101&to=9799&format=JSON&styles=false`,
  );
  return { rows: parseBaseRows(raw), raw };
}

/** Pure: normalize the exportList payload into BaseScheduleRows. Codeless
 *  decision-branch rows are KEPT (htsno "") — the base ETL's indent stack
 *  needs them for hierarchy context. */
export function parseBaseRows(raw: unknown): BaseScheduleRow[] {
  return exportListRows(raw).map((row) => ({
    htsno: str(row.htsno),
    indent: Number(str(row.indent)) || 0, // arrives as a string ("0".."n")
    description: str(row.description),
    general: str(row.general),
    special: str(row.special),
    other: str(row.other),
    unitOfQuantity: unitOf(row),
  }));
}

/** exportList has served both a bare array and { HTSDataSet: [...] } /
 *  { results: [...] } wrappers over time (legacy-verified) — accept all. */
function exportListRows(raw: unknown): Record<string, unknown>[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null
      ? ((raw as Record<string, unknown>).HTSDataSet ??
        (raw as Record<string, unknown>).results)
      : null;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (r): r is Record<string, unknown> => typeof r === "object" && r !== null,
  );
}

/** USITC returns units either as unit1/unit2 strings or a "units" array
 *  depending on the endpoint; collapse both into one display string. */
function unitOf(row: Record<string, unknown>): string {
  if (Array.isArray(row.units)) {
    return row.units
      .map((u) => str(u))
      .filter(Boolean)
      .join(", ");
  }
  return [row.unit1, row.unit2, row.unit_of_quantity]
    .map((u) => str(u))
    .filter(Boolean)
    .join(", ");
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

// Pure mapping of the legacy moby platform's hand-curated Chapter 99 data
// into staged create_measure / rate_change proposals — years of human
// curation reused as REVIEW INPUT, never as direct reference writes. The
// one-time import script (scripts/import-legacy-tariff.ts) is a thin IO
// shell around this module; everything parseable and decidable is here,
// tested. Sources at <MOBY_DIR>:
//   data/trade_measures/chapter_99_measures.json    64 curated measures
//   data/lookups/section_301_mappings.csv           General_HTS,Section_301_HTS
//   data/lookups/section_232_*.csv                  base<->ch99 coverage
//   data/lookups/section_338_*.csv                  Chapter99_HTS,General_HTS,...
//   data/lookups/timber_furniture_mappings.csv      Chapter99_HTS,General_HTS
//   app/services/hts_maintenance/chapter_99_date_backfiller.rb
//     (MEASURE_DATES transcribed below — Ruby is not parsed at runtime)
//
// Relative imports on purpose — this module runs under tsx scripts.

import { createHash } from "node:crypto";

import { normalizeHts } from "../duty/calculator";
import { classifyAuthority } from "./differ";
import type {
  OpenRevisionRef,
  ProposedRevision,
  TariffSyncState,
} from "./types";

export type LegacyMeasureRow = {
  htsDigits: string; // "99038801"
  ch99Code: string; // "9903.88.01"
  rate: number; // decimal fraction
  description: string;
  fullDescription: string;
  effectiveDate: string;
  endDate: string | null;
  countries: string[] | null;
  exemption: boolean;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class LegacyImportError extends Error {}

/** Validate + normalize chapter_99_measures.json. Rows that are not
 *  ad-valorem measures (fee_type — e.g. the per-net-ton Chinese vessel port
 *  fee) don't fit ProposedMeasureChange and are excluded, reported by code. */
export function parseLegacyMeasures(json: unknown): {
  rows: LegacyMeasureRow[];
  excluded: { code: string; reason: string }[];
} {
  if (!Array.isArray(json)) {
    throw new LegacyImportError("chapter_99_measures.json: expected an array");
  }
  const rows: LegacyMeasureRow[] = [];
  const excluded: { code: string; reason: string }[] = [];

  for (const item of json) {
    if (typeof item !== "object" || item === null) {
      throw new LegacyImportError("chapter_99_measures.json: non-object row");
    }
    const r = item as Record<string, unknown>;
    const rawCode = String(r.hts_code ?? "");
    const digits = normalizeHts(rawCode);
    if (!/^9903\d{4}$/.test(digits)) {
      throw new LegacyImportError(
        `chapter_99_measures.json: "${rawCode}" is not an 8-digit 9903 code`,
      );
    }
    const code = `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6, 8)}`;

    if (r.fee_type) {
      excluded.push({
        code,
        reason: `fee_type "${String(r.fee_type)}" is not an ad-valorem measure`,
      });
      continue;
    }

    const rate = Number(r.rate);
    if (!Number.isFinite(rate) || rate < 0) {
      throw new LegacyImportError(
        `chapter_99_measures.json: ${code} has unusable rate "${String(r.rate)}"`,
      );
    }
    const effectiveDate = String(r.effective_date ?? "");
    if (!ISO_DATE.test(effectiveDate)) {
      throw new LegacyImportError(
        `chapter_99_measures.json: ${code} has unusable effective_date "${effectiveDate}"`,
      );
    }
    const endDate =
      r.end_date && ISO_DATE.test(String(r.end_date)) ? String(r.end_date) : null;
    const countries = Array.isArray(r.countries)
      ? r.countries.map(String).filter((c) => /^[A-Z]{2}$/.test(c))
      : null;

    rows.push({
      htsDigits: digits,
      ch99Code: code,
      rate,
      description: String(r.description ?? code),
      fullDescription: String(r.full_description ?? r.description ?? code),
      effectiveDate,
      endDate,
      countries: countries && countries.length > 0 ? countries : null,
      exemption: r.exemption === true,
    });
  }

  return { rows, excluded };
}

/** Parse one coverage CSV into ch99Digits -> base HTS digit prefixes.
 *  Column names are explicit per file (the legacy CSVs disagree on order);
 *  a "base" cell that is itself a 9903 code fails loudly — moby shipped a
 *  MisorientedExclusionCsv guard for exactly this mistake. */
export function parseMappingCsv(
  text: string,
  opts: { ch99Column: string; baseColumn: string },
): Map<string, string[]> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return new Map();

  const header = lines[0].split(",").map((h) => h.trim());
  const ch99Idx = header.indexOf(opts.ch99Column);
  const baseIdx = header.indexOf(opts.baseColumn);
  if (ch99Idx === -1 || baseIdx === -1) {
    throw new LegacyImportError(
      `mapping CSV: missing column "${ch99Idx === -1 ? opts.ch99Column : opts.baseColumn}" (header: ${lines[0]})`,
    );
  }

  const out = new Map<string, Set<string>>();
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    const ch99 = normalizeHts(cells[ch99Idx]?.trim() ?? "");
    const base = normalizeHts(cells[baseIdx]?.trim() ?? "");
    if (!ch99 && !base) continue;
    if (!ch99.startsWith("9903")) {
      throw new LegacyImportError(
        `mapping CSV row ${i + 1}: "${cells[ch99Idx]}" in the ${opts.ch99Column} column is not a 9903 code — mis-oriented columns?`,
      );
    }
    if (base.startsWith("9903")) {
      throw new LegacyImportError(
        `mapping CSV row ${i + 1}: "${cells[baseIdx]}" in the ${opts.baseColumn} column is itself a 9903 code — mis-oriented columns?`,
      );
    }
    if (base.length === 0) continue;
    const set = out.get(ch99) ?? new Set<string>();
    set.add(base);
    out.set(ch99, set);
  }

  return new Map([...out.entries()].map(([k, v]) => [k, [...v].sort()]));
}

/** Merge per-file prefix maps (union per code). */
export function mergePrefixMaps(
  maps: Map<string, string[]>[],
): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const map of maps) {
    for (const [code, prefixes] of map) {
      const set = out.get(code) ?? new Set<string>();
      for (const p of prefixes) set.add(p);
      out.set(code, set);
    }
  }
  return new Map([...out.entries()].map(([k, v]) => [k, [...v].sort()]));
}

/** moby's Chapter99DateBackfiller.MEASURE_DATES, transcribed verbatim from
 *  app/services/hts_maintenance/chapter_99_date_backfiller.rb — dates
 *  hand-curated there from Federal Register notices, proclamations, and CBP
 *  CSMS guidance. End-date convention matches ours (inclusive; a measure
 *  ending for entries on/after D is stored as D − 1 — e.g. the IEEPA
 *  termination for entries on/after 2026-02-24 → end_date 2026-02-23).
 *  These are NEWER curation than chapter_99_measures.json and override it. */
export const BACKFILLER_DATES: {
  code: string;
  effectiveDate: string;
  endDate: string | null;
}[] = [
  { code: "9903.01.22", effectiveDate: "2025-02-04", endDate: "2026-02-23" },
  { code: "9903.01.01", effectiveDate: "2025-03-04", endDate: "2026-02-23" },
  { code: "9903.01.10", effectiveDate: "2025-03-04", endDate: "2026-02-23" },
  { code: "9903.01.14", effectiveDate: "2025-03-07", endDate: "2026-02-23" },
  { code: "9903.01.26", effectiveDate: "2025-04-05", endDate: "2026-02-23" },
  { code: "9903.01.27", effectiveDate: "2025-04-05", endDate: "2026-02-23" },
  { code: "9903.01.30", effectiveDate: "2025-04-05", endDate: "2026-02-23" },
  { code: "9903.01.31", effectiveDate: "2025-04-05", endDate: "2026-02-23" },
  { code: "9903.01.34", effectiveDate: "2025-04-05", endDate: "2026-02-23" },
  { code: "9903.01.50", effectiveDate: "2025-04-09", endDate: "2025-08-06" },
  { code: "9903.01.53", effectiveDate: "2025-04-09", endDate: "2025-08-06" },
  { code: "9903.02.19", effectiveDate: "2025-08-07", endDate: "2026-02-23" },
  { code: "9903.02.20", effectiveDate: "2025-08-07", endDate: "2026-02-23" },
  { code: "9903.02.29", effectiveDate: "2025-08-07", endDate: "2026-02-23" },
  { code: "9903.02.30", effectiveDate: "2025-08-07", endDate: "2026-02-23" },
  { code: "9903.02.51", effectiveDate: "2025-08-07", endDate: "2026-02-23" },
  { code: "9903.02.66", effectiveDate: "2025-08-07", endDate: "2026-02-23" },
  { code: "9903.02.72", effectiveDate: "2025-08-07", endDate: "2026-02-23" },
  { code: "9903.02.73", effectiveDate: "2025-08-07", endDate: "2026-02-23" },
  { code: "9903.85.15", effectiveDate: "2025-06-04", endDate: null },
  { code: "9903.82.03", effectiveDate: "2026-04-06", endDate: null },
  { code: "9903.76.02", effectiveDate: "2025-10-14", endDate: null },
  { code: "9903.74.10", effectiveDate: "2025-11-01", endDate: null },
  { code: "9903.88.21", effectiveDate: "2018-09-24", endDate: null },
];

const backfillerByDigits = new Map(
  BACKFILLER_DATES.map((d) => [normalizeHts(d.code), d]),
);

export type LegacyBuildResult = {
  revisions: ProposedRevision[];
  /** Codes already live with no material difference. */
  skippedLive: string[];
  /** Codes with an identical open proposal already pending. */
  skippedPending: string[];
};

/** Content hash over the curated SOURCE row (+ prefixes), so a re-run with
 *  unchanged files dedupes against open revisions and edited curated data
 *  supersedes-and-restages — the same idempotency property as a USITC
 *  re-sync. */
export function legacyContentHash(
  row: LegacyMeasureRow,
  prefixes: string[],
): string {
  return createHash("sha256")
    .update(
      [
        "legacy-moby",
        row.htsDigits,
        row.rate.toFixed(6),
        row.description,
        row.fullDescription,
        row.effectiveDate,
        row.endDate ?? "",
        (row.countries ?? []).join(","),
        row.exemption ? "exempt" : "",
        prefixes.join(","),
      ].join("|"),
    )
    .digest("hex");
}

export function buildLegacyRevisions(
  curated: LegacyMeasureRow[],
  prefixesByDigits: Map<string, string[]>,
  state: TariffSyncState,
  openRevisions: OpenRevisionRef[],
  opts: {
    /** Appended to reciprocal-family proposals' notes (annex country rates
     *  from reciprocal_tariffs.csv — context for the reviewer, v1 does not
     *  mint per-country measures from it). */
    reciprocalNote?: string;
  } = {},
): LegacyBuildResult {
  const openHashes = new Set(openRevisions.map((o) => o.contentHash));
  const result: LegacyBuildResult = {
    revisions: [],
    skippedLive: [],
    skippedPending: [],
  };

  for (const row of curated) {
    const backfill = backfillerByDigits.get(row.htsDigits);
    const effectiveDate = backfill?.effectiveDate ?? row.effectiveDate;
    const endDate = backfill ? backfill.endDate : row.endDate;
    const dated: LegacyMeasureRow = { ...row, effectiveDate, endDate };

    const prefixes = prefixesByDigits.get(row.htsDigits) ?? [];
    const hash = legacyContentHash(dated, prefixes);
    if (openHashes.has(hash)) {
      result.skippedPending.push(row.ch99Code);
      continue;
    }

    const live = state.byDigits.get(row.htsDigits) ?? null;
    const authority =
      live?.authority ??
      classifyAuthority(`${dated.fullDescription} ${dated.description}`, row.ch99Code);

    const baseNotes = "Imported from legacy moby curated data (chapter_99_measures.json + Chapter99DateBackfiller).";
    const notes =
      authority === "reciprocal" && opts.reciprocalNote
        ? `${baseNotes} ${opts.reciprocalNote}`
        : baseNotes;

    const evidence = {
      description: dated.fullDescription,
      general: "",
      special: "",
      additionalDuties: "",
      footnotes: "",
      highlights: [],
    };

    if (!live) {
      result.revisions.push({
        changeType: "create_measure",
        ch99Code: row.ch99Code,
        authority,
        targetMeasureId: null,
        proposed: {
          name: dated.description,
          authority,
          scope: prefixes.length > 0 ? "hts_list" : "all_products",
          countries: dated.countries,
          countriesExcluded: null,
          effectiveDate: dated.effectiveDate,
          endDate: dated.endDate,
          sailedOnOrAfter: null,
          sailedOnOrBefore: null,
          // The curated JSON is all decimal fractions — fee-type rows were
          // excluded at parse time, so everything here is ad valorem.
          rate: dated.exemption ? 0 : dated.rate,
          rateType: "ad_valorem",
          rateText: null,
          exemption: dated.exemption,
          inLieuOfBaseDuty: false,
          prefixes,
          notes,
        },
        evidence,
        liveSnapshot: null,
        contentHash: hash,
      });
      continue;
    }

    // Already live (seed overlap): stage a change only when the curated data
    // materially differs from the live window.
    const rateDiffers =
      live.rate !== null && Math.abs(live.rate - dated.rate) > 1e-9;
    const datesDiffer =
      live.effectiveDate !== dated.effectiveDate || live.endDate !== dated.endDate;
    const countriesDiffer =
      JSON.stringify(live.countries ?? null) !==
      JSON.stringify(dated.countries ?? null);
    if (!rateDiffers && !datesDiffer && !countriesDiffer) {
      result.skippedLive.push(row.ch99Code);
      continue;
    }

    result.revisions.push({
      changeType: rateDiffers ? "rate_change" : "note_change",
      ch99Code: row.ch99Code,
      authority: live.authority,
      targetMeasureId: live.measureId,
      proposed: {
        name: live.name,
        authority: live.authority,
        scope: live.scope,
        countries: dated.countries ?? live.countries,
        effectiveDate: dated.effectiveDate,
        endDate: dated.endDate,
        sailedOnOrAfter: live.sailedOnOrAfter,
        sailedOnOrBefore: live.sailedOnOrBefore,
        rate: rateDiffers ? dated.rate : live.rate,
        exemption: live.exemption,
        inLieuOfBaseDuty: false,
        prefixes: prefixes.length > 0 ? prefixes : live.prefixes,
        notes,
      },
      evidence,
      liveSnapshot: live,
      contentHash: hash,
    });
  }

  return result;
}

/** "Annex I country rates: CN 34%, EU 20%, …" from reciprocal_tariffs.csv —
 *  reviewer context only. */
export function buildReciprocalNote(csvText: string, cap = 12): string | null {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;
  const entries: string[] = [];
  for (const line of lines.slice(1, 1 + cap)) {
    const cells = line.split(",");
    const country = cells[0]?.trim();
    const rate = cells[2]?.trim();
    if (country && rate) entries.push(`${country} ${rate}`);
  }
  if (entries.length === 0) return null;
  const more = lines.length - 1 - entries.length;
  return (
    `Legacy annex country rates: ${entries.join(", ")}` +
    (more > 0 ? ` (+${more} more)` : "") +
    "."
  );
}

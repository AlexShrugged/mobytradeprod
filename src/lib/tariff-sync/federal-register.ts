// Federal Register API fetcher. FR notices are where savings clauses live
// in prose ("laden before ... entered before ..."), so they land as
// announcements — reviewer context linked from the tariffs page — not as
// staged revisions. The structured diff comes from USITC.

import type { FrNotice } from "./types";

const API = "https://www.federalregister.gov/api/v1/documents.json";
const TIMEOUT_MS = 60_000;
const PER_PAGE = 100;
// Runaway guard, not an expected limit: the query below matches ~60
// documents across a full two-year window (measured 2026-08), so five
// pages of headroom is 8x observed volume.
const MAX_PAGES = 5;

// A notice must hit at least one to survive (moby-verified guard list —
// FR search terms alone are too noisy).
const KEYWORD_GUARD =
  /\b(tariff|duty|duties|harmonized tariff schedule|hts|chapter 99|section 301|section 232|section 122|reciprocal|ad valorem)\b/i;

export function passesKeywordGuard(n: {
  title: string;
  abstract: string | null;
}): boolean {
  return KEYWORD_GUARD.test(`${n.title} ${n.abstract ?? ""}`);
}

export async function fetchRecentNotices(opts: {
  daysBack: number;
  today: string; // ISO date — passed in so the fetcher stays clock-free
}): Promise<{ notices: FrNotice[]; raw: unknown }> {
  const gte = shiftDays(opts.today, -opts.daysBack);
  const notices: FrNotice[] = [];
  const pages: unknown[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({
      "conditions[term]": '"harmonized tariff schedule" OR "additional duties"',
      "conditions[publication_date][gte]": gte,
      "conditions[type][]": "PRESDOCU",
      order: "newest",
      per_page: String(PER_PAGE),
      page: String(page),
    });
    params.append("conditions[type][]", "NOTICE");
    params.append("conditions[type][]", "RULE");
    for (const f of NOTICE_FIELDS) params.append("fields[]", f);

    const res = await fetch(`${API}?${params}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Federal Register ${res.status}`);
    const raw = (await res.json()) as {
      results?: unknown[];
      next_page_url?: unknown;
    };
    pages.push(raw);

    for (const r of raw.results ?? []) {
      const notice = mapNoticeRow(r);
      if (notice && passesKeywordGuard(notice)) notices.push(notice);
    }

    if (!raw.next_page_url || (raw.results?.length ?? 0) < PER_PAGE) break;
  }

  return { notices, raw: pages };
}

function mapNoticeRow(r: unknown): FrNotice | null {
  if (typeof r !== "object" || r === null) return null;
  const row = r as Record<string, unknown>;
  if (typeof row.document_number !== "string") return null;
  return {
    documentNumber: row.document_number,
    title: typeof row.title === "string" ? row.title : row.document_number,
    htmlUrl: typeof row.html_url === "string" ? row.html_url : "",
    publicationDate:
      typeof row.publication_date === "string" ? row.publication_date : "",
    abstract: typeof row.abstract === "string" ? row.abstract : null,
    agencies: Array.isArray(row.agencies)
      ? row.agencies
          .map((a) =>
            typeof a === "object" && a !== null && "name" in a
              ? String((a as { name: unknown }).name)
              : "",
          )
          .filter(Boolean)
      : [],
    rawTextUrl: typeof row.raw_text_url === "string" ? row.raw_text_url : null,
  };
}

const NOTICE_FIELDS = [
  "document_number",
  "title",
  "html_url",
  "publication_date",
  "abstract",
  "agencies",
  "raw_text_url",
];
const SEARCH_CONCURRENCY = 3;

/** Targeted retrieval: FR full-text search for documents that PRINT a
 *  given Chapter 99 code. The founding proclamations for 232/IEEPA
 *  families rarely match the generic term query ("Adjusting Imports of
 *  Automobiles…" says neither "harmonized tariff schedule" nor
 *  "additional duties" in searchable text), but they enumerate the codes
 *  they create — so the code itself is the only reliable search key. The
 *  FR tokenizer treats a dotted code as one token: exact quoted codes
 *  match, prefixes and OR-batches do not, hence one query per code. Codes
 *  are searched individually and best-effort; failures skip that code.
 *  No keyword guard — a document printing the code is relevant by
 *  construction. */
export async function searchNoticesForCodes(
  codes: string[],
  opts: { daysBack: number; today: string },
): Promise<FrNotice[]> {
  const gte = shiftDays(opts.today, -opts.daysBack);
  const byDocument = new Map<string, FrNotice>();
  const unique = [...new Set(codes)];
  let next = 0;
  const worker = async () => {
    while (next < unique.length) {
      const code = unique[next++];
      const params = new URLSearchParams({
        "conditions[term]": `"${code}"`,
        "conditions[publication_date][gte]": gte,
        "conditions[type][]": "PRESDOCU",
        order: "newest",
        per_page: "20",
      });
      params.append("conditions[type][]", "NOTICE");
      params.append("conditions[type][]", "RULE");
      for (const f of NOTICE_FIELDS) params.append("fields[]", f);
      try {
        const res = await fetch(`${API}?${params}`, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) continue;
        const raw = (await res.json()) as { results?: unknown[] };
        for (const r of raw.results ?? []) {
          const notice = mapNoticeRow(r);
          if (notice) byDocument.set(notice.documentNumber, notice);
        }
      } catch {
        // Best-effort per code — a failed search degrades context only.
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SEARCH_CONCURRENCY, unique.length) }, worker),
  );
  return [...byDocument.values()];
}

const TEXT_CONCURRENCY = 5;
// A proclamation body with annex tables can run to megabytes; the clipper
// only ever excerpts around code mentions, but cap what we hold in memory.
const MAX_TEXT_CHARS = 400_000;

/** Fetch plain-text bodies for notices that have one. Best-effort by
 *  contract: a failed body fetch leaves that notice abstract-only —
 *  degraded extraction context must never fail the sync. Returns new
 *  notice objects; the input array is not mutated. */
export async function hydrateNoticeTexts(
  notices: FrNotice[],
): Promise<FrNotice[]> {
  const out = [...notices];
  let next = 0;
  const worker = async () => {
    while (next < out.length) {
      const i = next++;
      const n = out[i];
      if (!n.rawTextUrl || n.fullText !== undefined) continue;
      try {
        const res = await fetch(n.rawTextUrl, {
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) continue;
        const text = await res.text();
        out[i] = { ...n, fullText: text.slice(0, MAX_TEXT_CHARS) };
      } catch {
        // Abstract-only beats failing the sync.
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(TEXT_CONCURRENCY, out.length) }, worker),
  );
  return out;
}

export function shiftDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

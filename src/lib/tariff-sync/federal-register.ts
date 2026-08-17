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
    for (const f of [
      "document_number",
      "title",
      "html_url",
      "publication_date",
      "abstract",
      "agencies",
    ]) {
      params.append("fields[]", f);
    }

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
      if (typeof r !== "object" || r === null) continue;
      const row = r as Record<string, unknown>;
      if (typeof row.document_number !== "string") continue;
      const notice: FrNotice = {
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
      };
      if (passesKeywordGuard(notice)) notices.push(notice);
    }

    if (!raw.next_page_url || (raw.results?.length ?? 0) < PER_PAGE) break;
  }

  return { notices, raw: pages };
}

export function shiftDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

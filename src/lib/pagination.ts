// Shared pagination vocabulary for the list pages (Entries, Variance,
// Parts, Events). Client-safe and pure — parsing lives here so the RSC
// pages and the URL controls can never disagree about defaults.

export const PER_PAGE_OPTIONS = [25, 50, 100, 250] as const;
export const DEFAULT_PER_PAGE = 50;

export function parsePerPage(raw: string | undefined): number {
  const n = Number(raw);
  return (PER_PAGE_OPTIONS as readonly number[]).includes(n)
    ? n
    : DEFAULT_PER_PAGE;
}

export function parsePage(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

export function parsePageParams(params: { page?: string; per?: string }): {
  page: number;
  per: number;
} {
  return { page: parsePage(params.page), per: parsePerPage(params.per) };
}

/** Always at least 1 — an empty list is page 1 of 1. */
export function pageCountFor(total: number, per: number): number {
  return Math.max(1, Math.ceil(total / per));
}

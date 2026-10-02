// Entries list vocabulary beyond the shared Phase filter: the Audit filter
// (?audit=) and the sort (?sort=). Client-safe and pure, like
// filter-params.ts and pagination.ts, so the RSC page, the client shell
// and the query can never disagree about values or defaults.

export const ENTRY_AUDIT_STATES = ["clear", "issues"] as const;
export type EntryAuditState = (typeof ENTRY_AUDIT_STATES)[number];

/** Dropdown vocabulary for the Audit filter. The two options partition the
 *  list by the Audit column: Issues is a row showing an open-findings count,
 *  Clear is every other row (the green check, or nothing to audit yet). */
export const AUDIT_OPTIONS: {
  state: EntryAuditState;
  label: string;
  title?: string;
}[] = [
  { state: "clear", label: "Clear", title: "No open findings" },
  { state: "issues", label: "Issues", title: "Open findings" },
];

export const ENTRY_SORTS = ["entry", "upload"] as const;
export type EntrySort = (typeof ENTRY_SORTS)[number];
export const DEFAULT_ENTRY_SORT: EntrySort = "entry";

/** Both sorts run newest first. */
export const SORT_OPTIONS: { sort: EntrySort; label: string }[] = [
  { sort: "entry", label: "Entry date" },
  { sort: "upload", label: "Upload date" },
];

/** Garbage decodes as the default sort, same as parsePage. */
export function parseEntrySort(raw: string | undefined): EntrySort {
  return (ENTRY_SORTS as readonly string[]).includes(raw ?? "")
    ? (raw as EntrySort)
    : DEFAULT_ENTRY_SORT;
}

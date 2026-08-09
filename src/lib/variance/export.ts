// The broker correction file: the filtered variance queue flattened to one
// CSV row per finding, in the reconciliation page's column order (Filed →
// Expected → Corrected). Every row is keyed by entry number + 7501 line so
// a broker can locate the merchandise without the app; Corrected carries
// the decided outcome only — the Expected side when accepted, the Filed
// side (no change) when dismissed, blank while the finding is still open.
// Pure string math; the download click stays in the view.

import { fieldIssue } from "./field-issue";

export type VarianceExportRow = {
  alertType: string;
  label: string;
  message: string;
  details: Record<string, unknown> | null;
  status: "open" | "resolved" | "dismissed";
  entryNumber: string;
  lineNumber: number | null;
  sku: string | null;
  description: string | null;
  /** Signed cents; positive = overpaid (refund due), negative = underpaid
   *  (additional duty owed) — the queue's convention. */
  impactCents: number | null;
  window: { estDate: string | null; closed: boolean };
};

// Est. liquidation matters to the broker: post-summary corrections can only
// be filed while the entry is unliquidated, so the date is the deadline
// proxy; liquidated lines need a protest instead.
export const VARIANCE_CSV_HEADER = [
  "Entry number",
  "Line",
  "SKU",
  "Description",
  "Variance",
  "Field",
  "Filed",
  "Expected",
  "Corrected",
  "Status",
  "Duty impact USD (+ refund / - owed)",
  "Est. liquidation",
  "Explanation",
];

const cell = (v: string) =>
  /[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;

function rowCells(r: VarianceExportRow): string[] {
  const issue = fieldIssue(r);
  const filed = issue?.filed ?? "";
  const expected = issue?.expected ?? "";
  const corrected =
    r.status === "resolved" ? expected : r.status === "dismissed" ? filed : "";
  return [
    r.entryNumber,
    r.lineNumber === null ? "" : String(r.lineNumber),
    r.sku ?? "",
    r.description ?? "",
    r.label,
    issue?.field ?? "",
    filed,
    expected,
    corrected,
    r.status === "resolved" ? "accepted" : r.status,
    r.impactCents === null ? "" : (r.impactCents / 100).toFixed(2),
    r.window.closed ? "liquidated" : (r.window.estDate ?? ""),
    r.message,
  ];
}

/** CRLF-joined per RFC 4180; rows arrive in the queue's display order. */
export function varianceCsv(rows: VarianceExportRow[]): string {
  return (
    [VARIANCE_CSV_HEADER, ...rows.map(rowCells)]
      .map((cells) => cells.map(cell).join(","))
      .join("\r\n") + "\r\n"
  );
}

// A finding reduced to its field-level diff — the expected/filed framing of
// the reconciliation page, compressed to one line of plain text. Pure string
// math over the alert's own details; shared by the entry page's inline
// findings and the variance CSV export.

import { formatHts, formatMoney, formatRate } from "@/lib/format";

export type FieldIssue = { field: string; expected: string; filed: string };

/** The variance admission rule for AI findings: the fields must present a
 *  COMPARISON — a filed-vs-expected diff (some row has a real expected
 *  value) or a filed-vs-filed disagreement (two or more declared values,
 *  the cross-entity inconsistency shape, where filling expected would
 *  assert which side is right). A finding with neither is an observation
 *  ("could not verify"), not a variance — it renders on the entry page's
 *  AI card but never joins the queue, the counts, or the line navigators.
 *  The entries-list count query mirrors this in SQL. */
export function hasActionableDiff(fields: unknown): boolean {
  if (!Array.isArray(fields)) return false;
  const has = (row: unknown, key: "filed" | "expected"): boolean => {
    if (!row || typeof row !== "object") return false;
    const v = (row as Record<string, unknown>)[key];
    return typeof v === "string" && v.trim() !== "";
  };
  if (fields.some((r) => has(r, "expected"))) return true;
  return fields.filter((r) => has(r, "filed")).length >= 2;
}

export function fieldIssue(a: {
  alertType: string;
  details: Record<string, unknown> | null;
}): FieldIssue | null {
  const d = a.details ?? {};
  const s = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : null);
  const n = (k: string) => (typeof d[k] === "number" ? (d[k] as number) : null);
  switch (a.alertType) {
    case "hts_discrepancy":
    case "invoice_hts_mismatch": {
      const e = s("expected_hts");
      const f = s("actual_hts");
      return e && f
        ? { field: "HTS", expected: formatHts(e), filed: formatHts(f) }
        : null;
    }
    case "hts_reclassified": {
      const e = s("expected_hts_current") ?? s("expected_hts");
      const f = s("actual_hts");
      return e && f
        ? { field: "HTS", expected: `${formatHts(e)} (now)`, filed: formatHts(f) }
        : null;
    }
    case "coo_discrepancy": {
      const e =
        s("expected_coo") ??
        (Array.isArray(d.expected_coos)
          ? (d.expected_coos as string[]).join(" / ")
          : null);
      return {
        field: "Origin",
        expected: e ?? "—",
        filed: s("declared_coo") ?? "—",
      };
    }
    case "rate_mismatch":
      return {
        field: "Duty rate",
        expected: formatRate(n("expected_rate")),
        filed: formatRate(n("actual_rate")),
      };
    case "amount_mismatch":
      return {
        field: "Duty amount",
        expected: formatMoney(n("expected_amount")),
        filed: formatMoney(n("actual_amount")),
      };
    case "value_mismatch":
      return {
        field: "Value",
        expected: formatMoney(n("expected_amount")),
        filed: formatMoney(n("actual_amount")),
      };
    case "quantity_discrepancy":
      return {
        field: "Quantity",
        expected: String(n("expected_quantity") ?? "—"),
        filed: String(n("actual_quantity") ?? "—"),
      };
    case "missing_measure":
      return {
        field: s("measure_name") ?? "Measure",
        expected: `declared at ${formatRate(n("expected_rate"))}`,
        filed: "not declared",
      };
    case "unexpected_measure":
      return {
        field: s("measure_name") ?? "Measure",
        expected: "not expected",
        filed: formatMoney(n("actual_amount")),
      };
    case "invoice_sku_missing":
      return {
        field: "Invoice coverage",
        expected: "on a linked invoice",
        filed: "not on any linked invoice",
      };
    default: {
      // AI findings carry their own filed-vs-expected rows in
      // details.fields; the first row speaks for the finding wherever a
      // single-line diff is wanted (queue cell, inline line findings, CSV).
      if (a.alertType.startsWith("ai_") && Array.isArray(d.fields)) {
        const first = (d.fields as unknown[])[0];
        if (first && typeof first === "object") {
          const f = first as {
            field?: unknown;
            filed?: unknown;
            expected?: unknown;
          };
          if (typeof f.field === "string") {
            return {
              field: f.field,
              expected: typeof f.expected === "string" ? f.expected : "—",
              filed: typeof f.filed === "string" ? f.filed : "—",
            };
          }
        }
      }
      return null;
    }
  }
}

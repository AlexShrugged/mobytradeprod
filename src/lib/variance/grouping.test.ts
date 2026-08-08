import { describe, expect, it } from "vitest";

import {
  compareSiblingAlerts,
  compareVarianceMembers,
  dedupedImpactSums,
  groupVarianceRows,
  nextOpenSiblingId,
  pairSiblingAlerts,
  partitionVarianceRows,
  unitIds,
  unitStatus,
  type AlertStatus,
  type GroupableRow,
} from "./grouping";

type StatusRow = GroupableRow & { status: AlertStatus };

let seq = 0;
const row = (over: Partial<StatusRow> = {}): StatusRow => ({
  alertId: `alert-${++seq}`,
  alertKey: `rate_mismatch:line1:base`,
  alertType: "rate_mismatch",
  severity: "warning",
  impactCents: null,
  entryId: "entry-A",
  entryNumber: "231-0000001-1",
  lineItemId: "line-A1",
  lineNumber: 1,
  href: "/variance/x",
  status: "open",
  ...over,
});

describe("dedupedImpactSums", () => {
  it("counts a same-entry rate+amount pair on one charge once", () => {
    const rows = [
      row({
        alertType: "rate_mismatch",
        alertKey: "rate_mismatch:line1:base",
        impactCents: 5_00,
      }),
      row({
        alertType: "amount_mismatch",
        alertKey: "amount_mismatch:line1:base",
        impactCents: 7_00,
      }),
    ];
    expect(dedupedImpactSums(rows)).toEqual({ recoverable: 7_00, exposure: 0 });
  });

  it("does not let entry A's amount row suppress entry B's rate row", () => {
    const rows = [
      row({
        entryId: "entry-A",
        alertType: "amount_mismatch",
        alertKey: "amount_mismatch:line1:base",
        impactCents: 7_00,
      }),
      row({
        entryId: "entry-B",
        alertType: "rate_mismatch",
        alertKey: "rate_mismatch:line1:base",
        impactCents: 5_00,
      }),
    ];
    expect(dedupedImpactSums(rows)).toEqual({
      recoverable: 12_00,
      exposure: 0,
    });
  });

  it("suppresses per-SKU value rows only when their entry has an impact-bearing invoice_total row in context", () => {
    const skuRow = row({
      alertType: "value_mismatch",
      alertKey: "value_mismatch:invoice_sku:EB-MTR-500W",
      impactCents: -3_00,
    });
    const totalRow = row({
      alertType: "value_mismatch",
      alertKey: "value_mismatch:invoice_total",
      impactCents: -9_00,
      lineItemId: null,
    });
    expect(dedupedImpactSums([skuRow, totalRow])).toEqual({
      recoverable: 0,
      exposure: 9_00,
    });
    // Subset sum: the suppressor sits outside `rows` but inside `context`.
    expect(dedupedImpactSums([skuRow], [skuRow, totalRow])).toEqual({
      recoverable: 0,
      exposure: 0,
    });
    // No suppressor anywhere → the SKU row's dollars count.
    expect(dedupedImpactSums([skuRow])).toEqual({
      recoverable: 0,
      exposure: 3_00,
    });
    // invoice_total in a different entry does not suppress.
    expect(
      dedupedImpactSums([skuRow, { ...totalRow, entryId: "entry-B" }]),
    ).toEqual({ recoverable: 0, exposure: 12_00 });
  });

  it("splits directions and skips null impacts", () => {
    const rows = [
      row({ alertKey: "a:1", alertType: "hts_discrepancy", impactCents: 10_00 }),
      row({ alertKey: "b:1", alertType: "missing_measure", impactCents: -4_00 }),
      row({ alertKey: "c:1", alertType: "coo_discrepancy", impactCents: null }),
    ];
    expect(dedupedImpactSums(rows)).toEqual({
      recoverable: 10_00,
      exposure: 4_00,
    });
  });
});

describe("compareVarianceMembers", () => {
  it("orders by |impact| desc with nulls last, then severity, then alertKey", () => {
    const members = [
      row({ alertKey: "b:key", severity: "error", impactCents: null }),
      row({ alertKey: "a:key", severity: "warning", impactCents: null }),
      row({ alertKey: "c:key", severity: "info", impactCents: -20_00 }),
      row({ alertKey: "d:key", severity: "error", impactCents: 5_00 }),
    ];
    const sorted = [...members].sort(compareVarianceMembers);
    expect(sorted.map((m) => m.alertKey)).toEqual([
      "c:key", // largest |impact|, sign ignored
      "d:key",
      "b:key", // null impacts: severity decides
      "a:key",
    ]);
  });

  it("ignores status by construction (no status field in the comparator input)", () => {
    // Compile-time guarantee more than runtime: the comparator only sees
    // impact/severity/alertKey, so Accept/Dismiss cannot reshuffle a card.
    expect(
      compareVarianceMembers(
        row({ alertKey: "same:key", impactCents: 1_00 }),
        row({ alertKey: "same:key", impactCents: 1_00 }),
      ),
    ).toBe(0);
  });
});

describe("compareSiblingAlerts", () => {
  it("bands decided issues above open ones, canonical order within bands", () => {
    const siblings = [
      row({ alertKey: "a:key", status: "open", impactCents: 50_00 }),
      row({ alertKey: "b:key", status: "resolved", impactCents: 1_00 }),
      row({ alertKey: "c:key", status: "open", impactCents: 2_00 }),
      row({ alertKey: "d:key", status: "dismissed", impactCents: 30_00 }),
    ];
    const sorted = [...siblings].sort(compareSiblingAlerts);
    expect(sorted.map((s) => s.alertKey)).toEqual([
      "d:key", // decided band, canonical order inside it
      "b:key",
      "a:key", // open band, canonical order inside it
      "c:key",
    ]);
  });

  it("puts a new issue last on a fully decided line — 3 of 3", () => {
    const siblings = [
      // The new arrival: open, biggest dollars — still sorts last.
      row({ alertKey: "new:key", status: "open", impactCents: 99_00 }),
      row({ alertKey: "old-a:key", status: "resolved", impactCents: 10_00 }),
      row({ alertKey: "old-b:key", status: "dismissed", impactCents: null }),
    ];
    const sorted = [...siblings].sort(compareSiblingAlerts);
    expect(sorted[2].alertKey).toBe("new:key");
  });

  it("matches the queue's canonical order when everything is open", () => {
    const siblings = [
      row({ alertKey: "b:key", impactCents: 1_00 }),
      row({ alertKey: "a:key", impactCents: 20_00 }),
    ];
    expect([...siblings].sort(compareSiblingAlerts)).toEqual(
      [...siblings].sort(compareVarianceMembers),
    );
  });
});

describe("groupVarianceRows", () => {
  it("groups by lineItemId, leaves null-lineItemId rows as singletons", () => {
    const rows = [
      row({ lineItemId: "line-A1", alertKey: "hts_discrepancy:line1" }),
      row({ lineItemId: "line-A1", alertKey: "coo_discrepancy:line1" }),
      row({ alertId: "entry-alert", lineItemId: null, lineNumber: null }),
    ];
    const groups = groupVarianceRows(rows);
    expect(groups).toHaveLength(2);
    const lineGroup = groups.find((g) => g.id === "line-A1")!;
    expect(lineGroup.members).toHaveLength(2);
    const singleton = groups.find((g) => g.id === "entry-alert")!;
    expect(singleton.members).toHaveLength(1);
  });

  it("sorts members worst-first and takes the row href from the worst member", () => {
    const rows = [
      row({
        lineItemId: "line-A1",
        alertKey: "coo_discrepancy:line1",
        impactCents: null,
        href: "/variance/small",
      }),
      row({
        lineItemId: "line-A1",
        alertKey: "hts_discrepancy:line1",
        impactCents: 162_000,
        href: "/variance/big",
      }),
    ];
    const [group] = groupVarianceRows(rows);
    expect(group.members[0].alertKey).toBe("hts_discrepancy:line1");
    expect(group.href).toBe("/variance/big");
  });

  it("sums group impact with the pair dedupe and orders groups by dollars in play", () => {
    const rows = [
      // Line 1: rate+amount pair (7.00 counts once) + an exposure row.
      row({
        lineItemId: "line-A1",
        alertType: "rate_mismatch",
        alertKey: "rate_mismatch:line1:base",
        impactCents: 5_00,
      }),
      row({
        lineItemId: "line-A1",
        alertType: "amount_mismatch",
        alertKey: "amount_mismatch:line1:base",
        impactCents: 7_00,
      }),
      row({
        lineItemId: "line-A1",
        alertType: "missing_measure",
        alertKey: "missing_measure:line1:99038803",
        impactCents: -2_00,
      }),
      // Line 2: bigger single issue — should outrank line 1's 9.00 total.
      row({
        lineItemId: "line-A2",
        lineNumber: 2,
        alertType: "hts_discrepancy",
        alertKey: "hts_discrepancy:line2",
        impactCents: 20_00,
      }),
      // Zero-impact line sorts last.
      row({
        lineItemId: "line-A3",
        lineNumber: 3,
        alertType: "quantity_discrepancy",
        alertKey: "quantity_discrepancy:invoice_sku:X",
        impactCents: null,
      }),
    ];
    const groups = groupVarianceRows(rows);
    expect(groups.map((g) => g.id)).toEqual(["line-A2", "line-A1", "line-A3"]);
    expect(groups[1].recoverableCents).toBe(7_00);
    expect(groups[1].exposureCents).toBe(2_00);
  });
});

describe("partitionVarianceRows", () => {
  it("archives lines where every issue is decided, entry singletons included", () => {
    const rows = [
      row({
        lineItemId: "line-A1",
        alertKey: "hts_discrepancy:line1",
        status: "resolved",
      }),
      row({
        lineItemId: "line-A1",
        alertKey: "coo_discrepancy:line1",
        status: "dismissed",
      }),
      row({
        alertId: "entry-alert",
        lineItemId: null,
        lineNumber: null,
        status: "resolved",
      }),
      row({ lineItemId: "line-A2", lineNumber: 2, status: "open" }),
    ];
    const { active, archived } = partitionVarianceRows(rows);
    expect(active.map((g) => g.id)).toEqual(["line-A2"]);
    expect(archived.map((g) => g.id).sort()).toEqual([
      "entry-alert",
      "line-A1",
    ]);
  });

  it("a new issue moves an archived line back to active, open members only", () => {
    const rows = [
      row({
        lineItemId: "line-A1",
        alertKey: "hts_discrepancy:line1",
        status: "resolved",
      }),
      // The new arrival on the same line.
      row({
        lineItemId: "line-A1",
        alertKey: "quantity_discrepancy:invoice_sku:X",
        alertType: "quantity_discrepancy",
        status: "open",
      }),
    ];
    const { active, archived } = partitionVarianceRows(rows);
    expect(archived).toHaveLength(0);
    expect(active).toHaveLength(1);
    // The decided sibling stays off the queue row — it lives on the detail
    // page's navigator card.
    expect(active[0].members.map((m) => m.alertKey)).toEqual([
      "quantity_discrepancy:invoice_sku:X",
    ]);
  });

  it("dedupes archived sums against the full queue, not just archived rows", () => {
    const rows = [
      // Archived line: a decided per-SKU value row...
      row({
        lineItemId: "line-A1",
        alertType: "value_mismatch",
        alertKey: "value_mismatch:invoice_sku:X",
        impactCents: -3_00,
        status: "dismissed",
      }),
      // ...whose entry-level suppressor is still open (an active singleton).
      row({
        alertId: "entry-alert",
        lineItemId: null,
        lineNumber: null,
        alertType: "value_mismatch",
        alertKey: "value_mismatch:invoice_total",
        impactCents: -9_00,
        status: "open",
      }),
    ];
    const { active, archived } = partitionVarianceRows(rows);
    expect(active[0].exposureCents).toBe(9_00);
    expect(archived[0].exposureCents).toBe(0);
  });
});

describe("pairSiblingAlerts", () => {
  const sib = (
    id: string,
    alertType: string,
    alertKey: string,
    status: AlertStatus = "open",
  ) => ({ id, alertType, alertKey, status });

  it("folds a rate/amount twin into one unit with the rate as primary", () => {
    const units = pairSiblingAlerts([
      sib("amt", "amount_mismatch", "amount_mismatch:line1:base"),
      sib("coo", "coo_discrepancy", "coo_discrepancy:line1"),
      sib("rate", "rate_mismatch", "rate_mismatch:line1:base"),
    ]);
    expect(units).toHaveLength(2);
    // Unit takes the FIRST-encountered member's position (the amount's),
    // but the rate is still its primary.
    expect(units[0].primary.id).toBe("rate");
    expect(units[0].consequence?.id).toBe("amt");
    expect(unitIds(units[0])).toEqual(["rate", "amt"]);
    expect(units[1]).toEqual({
      primary: sib("coo", "coo_discrepancy", "coo_discrepancy:line1"),
      consequence: null,
    });
  });

  it("does not pair across different charges, and pairs per charge", () => {
    const units = pairSiblingAlerts([
      sib("rate-base", "rate_mismatch", "rate_mismatch:line1:base"),
      sib("amt-301", "amount_mismatch", "amount_mismatch:line1:99038803"),
      sib("rate-301", "rate_mismatch", "rate_mismatch:line1:99038803"),
    ]);
    expect(units).toHaveLength(2);
    expect(unitIds(units[0])).toEqual(["rate-base"]); // no base amount twin
    expect(unitIds(units[1])).toEqual(["rate-301", "amt-301"]);
  });

  it("unitStatus is open while any member is open, else the primary's call", () => {
    const open = pairSiblingAlerts([
      sib("rate", "rate_mismatch", "rate_mismatch:line1:base", "resolved"),
      sib("amt", "amount_mismatch", "amount_mismatch:line1:base", "open"),
    ])[0];
    expect(unitStatus(open)).toBe("open");
    // The lol case — one accepted, one dismissed — reads as the primary's
    // decision, and re-deciding the unit re-aligns both rows.
    const diverged = pairSiblingAlerts([
      sib("rate", "rate_mismatch", "rate_mismatch:line1:base", "dismissed"),
      sib("amt", "amount_mismatch", "amount_mismatch:line1:base", "resolved"),
    ])[0];
    expect(unitStatus(diverged)).toBe("dismissed");
  });
});

describe("nextOpenSiblingId", () => {
  const sib = (id: string, status: "open" | "resolved" | "dismissed") => ({
    id,
    status,
  });

  it("picks the first open sibling below the current one", () => {
    const siblings = [
      sib("a", "open"),
      sib("b", "open"),
      sib("c", "resolved"),
      sib("d", "open"),
    ];
    expect(nextOpenSiblingId(siblings, "b")).toBe("d");
  });

  it("wraps to open siblings above when nothing below is open", () => {
    const siblings = [
      sib("a", "open"),
      sib("b", "dismissed"),
      sib("c", "open"),
    ];
    expect(nextOpenSiblingId(siblings, "c")).toBe("a");
  });

  it("returns null when no other sibling is open", () => {
    const siblings = [
      sib("a", "resolved"),
      sib("b", "open"),
      sib("c", "dismissed"),
    ];
    // "b" is the current one being decided — nothing else is open.
    expect(nextOpenSiblingId(siblings, "b")).toBeNull();
    expect(nextOpenSiblingId([sib("only", "open")], "only")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { buildSeedReferenceData, type DayFn } from "../db/seed-data/tariff";
import {
  buildQuoteComparison,
  buildReconsiderProposal,
  diffComparisons,
  selectHtsBasis,
  type ComparisonInput,
  type ComparisonQuoteInput,
  type ComparisonSourceInput,
} from "./compare";

// Fixed anchor (2026-08-11) — see calculator.test.ts.
const day: DayFn = (offset) =>
  new Date(Date.UTC(2026, 7, 11) + offset * 86_400_000)
    .toISOString()
    .slice(0, 10);
const ref = buildSeedReferenceData(day);

// Before Section 301 List 1 (2018-07-06) and the reciprocal baseline
// (2025-04-05): a CN and a VN source pay only the 4% base rate. After both:
// CN carries +25% +10%, VN only +10%.
const PRE_301 = "2018-01-01";
const TODAY = "2026-06-10";
const MOTOR = "8501.31.4000";

const source = (
  overrides: Partial<ComparisonSourceInput> & { sourceId: string },
): ComparisonSourceInput => ({
  vendorId: `vendor-${overrides.sourceId}`,
  vendorName: `Vendor ${overrides.sourceId}`,
  unitCost: "100.0000",
  countryOfOrigin: "CN",
  ...overrides,
});

const quote = (
  overrides: Partial<ComparisonQuoteInput> & { quoteLineId: string },
): ComparisonQuoteInput => ({
  vendorId: null,
  supplierName: `Supplier ${overrides.quoteLineId}`,
  quoteDate: "2026-06-01",
  status: "received",
  unitCost: "110.0000",
  currency: "USD",
  countryOfOrigin: "VN",
  ...overrides,
});

const committed = (
  sources: ComparisonSourceInput[],
  quotes: ComparisonQuoteInput[],
): ComparisonInput => ({
  part: { htsCode: MOTOR, htsCodeProvisional: false },
  candidates: [],
  sources,
  quotes,
});

describe("selectHtsBasis", () => {
  const candidates = [
    { code: "8501.31.4000", codeDigits: "8501314000", confidence: 0.8 },
    { code: "8501.31.8000", codeDigits: "8501318000", confidence: 0.4 },
  ];

  it("a committed code stands alone", () => {
    const basis = selectHtsBasis(
      { htsCode: "8501.31.4000", htsCodeProvisional: false },
      candidates,
    );
    expect(basis.kind).toBe("committed");
    expect(basis.digits).toBe("8501314000");
    expect(basis.confidence).toBe(0.8);
    expect(basis.alternatives).toEqual([]);
  });

  it("a provisional code leads its run's other candidates", () => {
    const basis = selectHtsBasis(
      { htsCode: "8501.31.4000", htsCodeProvisional: true },
      candidates,
    );
    expect(basis.kind).toBe("provisional");
    expect(basis.alternatives.map((a) => a.digits)).toEqual(["8501318000"]);
  });

  it("no code: the ranked candidates lead", () => {
    const basis = selectHtsBasis(
      { htsCode: null, htsCodeProvisional: false },
      candidates,
    );
    expect(basis.kind).toBe("candidate");
    expect(basis.code).toBe("8501.31.4000");
    expect(basis.alternatives).toHaveLength(1);
  });

  it("nothing to price under", () => {
    expect(selectHtsBasis({ htsCode: null, htsCodeProvisional: false }, []))
      .toEqual({ kind: "none", code: null, digits: null, confidence: null, alternatives: [] });
  });
});

describe("buildQuoteComparison", () => {
  it("prices every option, marks the cheapest, and orders cheapest first", () => {
    const cmp = buildQuoteComparison(
      committed(
        [source({ sourceId: "a" })],
        [quote({ quoteLineId: "q1" }), quote({ quoteLineId: "q2", unitCost: "150.0000" })],
      ),
      ref,
      TODAY,
    );
    // CN $100 → 139 + fees; VN $110 → 125.4 + fees; VN $150 → 171 + fees.
    expect(cmp.options.map((o) => o.key)).toEqual([
      "quote:q1",
      "source:a",
      "quote:q2",
    ]);
    expect(cmp.cheapestKey).toBe("quote:q1");
    expect(cmp.chosenKey).toBe("source:a");
    expect(cmp.comparableCount).toBe(3);
    const [q1, a] = cmp.options;
    expect(q1.cheapest).toBe(true);
    expect(q1.deltaVsCheapestCents).toBe(0);
    expect(a.deltaVsCheapestCents).toBeGreaterThan(0);
    expect(a.landed?.components.map((c) => c.label)).toContain(
      "Section 301 List 1 — China (25%)",
    );
  });

  it("a quote inherits its vendor's source origin when the line has none", () => {
    const cmp = buildQuoteComparison(
      committed(
        [source({ sourceId: "a", vendorId: "v-a", countryOfOrigin: "VN" })],
        [quote({ quoteLineId: "q1", vendorId: "v-a", countryOfOrigin: null })],
      ),
      ref,
      TODAY,
    );
    const q1 = cmp.options.find((o) => o.key === "quote:q1")!;
    expect(q1.countryOfOrigin).toBe("VN");
    expect(q1.landed?.components.map((c) => c.label)).not.toContain(
      "Section 301 List 1 — China (25%)",
    );
  });

  it("superseded quotes and foreign-currency quotes never rank", () => {
    const cmp = buildQuoteComparison(
      committed(
        [source({ sourceId: "a" })],
        [
          quote({ quoteLineId: "stale", status: "superseded", unitCost: "1.0000" }),
          quote({ quoteLineId: "eur", currency: "EUR", unitCost: "1.0000" }),
          quote({ quoteLineId: "live" }),
        ],
      ),
      ref,
      TODAY,
    );
    expect(cmp.cheapestKey).toBe("quote:live");
    expect(cmp.comparableCount).toBe(2);
    const stale = cmp.options.find((o) => o.key === "quote:stale")!;
    expect(stale.eligible).toBe(false);
    expect(stale.landedPerUnitCents).not.toBeNull();
    expect(stale.deltaVsCheapestCents).toBeNull();
    const eur = cmp.options.find((o) => o.key === "quote:eur")!;
    expect(eur.landed).toBeNull();
    expect(eur.eligible).toBe(false);
    // Unranked options trail the ranked ones.
    expect(cmp.options.slice(-2).map((o) => o.key).sort()).toEqual([
      "quote:eur",
      "quote:stale",
    ]);
  });

  it("approved and applied quotes count as chosen; received and rejected do not", () => {
    const cmp = buildQuoteComparison(
      committed(
        [],
        [
          quote({ quoteLineId: "ap", status: "approved", unitCost: "200.0000" }),
          quote({ quoteLineId: "rj", status: "rejected", unitCost: "100.0000" }),
        ],
      ),
      ref,
      TODAY,
    );
    expect(cmp.cheapestKey).toBe("quote:rj");
    expect(cmp.chosenKey).toBe("quote:ap");
  });

  it("a source without a cost is neither chosen nor priced", () => {
    const cmp = buildQuoteComparison(
      committed([source({ sourceId: "a", unitCost: null })], []),
      ref,
      TODAY,
    );
    const a = cmp.options[0];
    expect(a.chosen).toBe(false);
    expect(a.landed).toBeNull();
    expect(cmp.cheapestKey).toBeNull();
    expect(cmp.comparableCount).toBe(0);
  });

  it("no code and no candidates: nothing prices", () => {
    const cmp = buildQuoteComparison(
      {
        part: { htsCode: null, htsCodeProvisional: false },
        candidates: [],
        sources: [source({ sourceId: "a" })],
        quotes: [],
      },
      ref,
      TODAY,
    );
    expect(cmp.basis.kind).toBe("none");
    expect(cmp.options[0].landed).toBeNull();
  });

  it("a candidate basis prices under the top candidate and can switch", () => {
    const input: ComparisonInput = {
      part: { htsCode: null, htsCodeProvisional: false },
      candidates: [
        { code: "4011.50.0000", codeDigits: "4011500000", confidence: 0.7 },
        { code: MOTOR, codeDigits: "8501314000", confidence: 0.3 },
      ],
      sources: [source({ sourceId: "a", countryOfOrigin: "VN" })],
      quotes: [],
    };
    const top = buildQuoteComparison(input, ref, TODAY);
    expect(top.basis.kind).toBe("candidate");
    expect(top.basis.code).toBe("4011.50.0000");
    expect(top.options[0].landed?.components.map((c) => c.label)).toContain(
      "Base duty (Free)",
    );

    const switched = buildQuoteComparison(input, ref, TODAY, {
      basisDigits: "8501314000",
    });
    expect(switched.basis.code).toBe(MOTOR);
    expect(switched.basis.alternatives.map((a) => a.digits)).toEqual([
      "4011500000",
    ]);
    expect(switched.options[0].landed?.components.map((c) => c.label)).toContain(
      "Base duty (4%)",
    );
  });
});

describe("diffComparisons", () => {
  const input = committed(
    [source({ sourceId: "a" })], // CN $100, the current buy
    [quote({ quoteLineId: "vn" })], // VN $110, received
  );

  it("fires when a tariff change moves the cheapest option", () => {
    const before = buildQuoteComparison(input, ref, PRE_301);
    const after = buildQuoteComparison(input, ref, TODAY);
    expect(before.cheapestKey).toBe("source:a");
    expect(after.cheapestKey).toBe("quote:vn");

    const signal = diffComparisons(before, after)!;
    expect(signal.cheapestKey).toBe("quote:vn");
    expect(signal.previousCheapestKey).toBe("source:a");
    expect(signal.chosenKey).toBe("source:a");
    const a = after.options.find((o) => o.key === "source:a")!;
    const vn = after.options.find((o) => o.key === "quote:vn")!;
    expect(signal.savingCents).toBe(
      (a.landedPerUnitCents as number) - (vn.landedPerUnitCents as number),
    );
  });

  it("stays silent when the ranking did not move", () => {
    const before = buildQuoteComparison(input, ref, TODAY);
    const after = buildQuoteComparison(input, ref, day(5));
    expect(diffComparisons(before, after)).toBeNull();
  });

  it("stays silent with fewer than two comparable options", () => {
    const single = committed([source({ sourceId: "a" })], []);
    const before = buildQuoteComparison(single, ref, PRE_301);
    const after = buildQuoteComparison(single, ref, TODAY);
    expect(diffComparisons(before, after)).toBeNull();
  });

  it("measures the saving against what was cheapest when nothing is chosen", () => {
    const open = committed(
      [],
      [
        quote({ quoteLineId: "cn", countryOfOrigin: "CN", unitCost: "100.0000" }),
        quote({ quoteLineId: "vn" }),
      ],
    );
    const before = buildQuoteComparison(open, ref, PRE_301);
    const after = buildQuoteComparison(open, ref, TODAY);
    const signal = diffComparisons(before, after)!;
    expect(signal.chosenKey).toBeNull();
    expect(signal.previousCheapestKey).toBe("quote:cn");
    expect(signal.savingCents).toBeGreaterThan(0);
  });
});

describe("buildReconsiderProposal", () => {
  it("carries labels, before/after figures, and the saving", () => {
    const input = committed(
      [source({ sourceId: "a", vendorName: "Shenzhen Volt" })],
      [quote({ quoteLineId: "vn", supplierName: "Hanoi Precision", quoteDate: "2026-06-01" })],
    );
    const before = buildQuoteComparison(input, ref, PRE_301);
    const after = buildQuoteComparison(input, ref, TODAY);
    const signal = diffComparisons(before, after)!;
    const proposal = buildReconsiderProposal(
      { sku: "EB-MTR-500W", partName: "Motor", changeLabel: "Section 301 List 1" },
      before,
      after,
      signal,
    );
    expect(proposal.cheapest.label).toBe("Hanoi Precision · Jun 1, 2026");
    expect(proposal.chosen?.label).toBe("Shenzhen Volt");
    expect(proposal.previousCheapest?.key).toBe("source:a");
    expect(proposal.basisKind).toBe("committed");
    expect(proposal.asOfBefore).toBe(PRE_301);
    expect(proposal.asOfAfter).toBe(TODAY);
    expect(proposal.savingCents).toBe(signal.savingCents);
    const a = proposal.options.find((o) => o.key === "source:a")!;
    expect(a.beforeCents).toBeLessThan(a.afterCents as number);
  });
});

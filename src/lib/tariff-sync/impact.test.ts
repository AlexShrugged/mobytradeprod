import { describe, expect, it } from "vitest";

import { classifyShipment, computeImpact, type ImpactMeasure, type ImpactShipment } from "./impact";

const TODAY = "2026-08-01";

function measure(over: Partial<ImpactMeasure> = {}): ImpactMeasure {
  return {
    id: "m-post",
    name: "Section 122 Import Surcharge",
    ch99Code: "9903.03.01",
    rate: 0.1,
    scope: "all_products",
    effectiveDate: "2026-08-01",
    endDate: null,
    sailedOnOrAfter: "2026-08-01",
    sailedOnOrBefore: null,
    ...over,
  };
}

function shipment(over: Partial<ImpactShipment> = {}): ImpactShipment {
  return {
    id: "s-1008",
    shipmentNumber: "SHP-1008",
    billOfLading: "ONEY9902218",
    sailedOnBoardDate: "2026-07-16",
    etd: "2026-07-15",
    eta: "2026-08-03",
    poTotalCents: 1_000_000,
    ...over,
  };
}

// The grace row: laden by Jul 31, surcharge bites on entries from Aug 11.
const graceRow = measure({
  id: "m-grace",
  name: "Section 122 — pre-cutoff sailings past grace",
  effectiveDate: "2026-08-11",
  sailedOnOrAfter: null,
  sailedOnOrBefore: "2026-07-31",
});

describe("classifyShipment", () => {
  it("SHP-1008 vs the post-cutoff row: provably spared (sailed early)", () => {
    expect(classifyShipment(shipment(), measure(), TODAY)).toBe("spared");
  });

  it("SHP-1008 vs the grace row: spared only if entered by Aug 10", () => {
    expect(classifyShipment(shipment(), graceRow, TODAY)).toEqual({
      sparedIfEnteredBy: "2026-08-10",
    });
  });

  it("a shipment that sailed after the cutoff is affected", () => {
    const late = shipment({ sailedOnBoardDate: "2026-08-02", eta: "2026-08-20" });
    expect(classifyShipment(late, measure(), TODAY)).toBe("affected");
    expect(classifyShipment(late, graceRow, TODAY)).toBe("spared");
  });

  it("ETA past the grace deadline makes the grace row bite", () => {
    const slow = shipment({ eta: "2026-08-20" });
    expect(classifyShipment(slow, graceRow, TODAY)).toBe("affected");
  });

  it("no dates at all -> unknown", () => {
    const dateless = shipment({ sailedOnBoardDate: null, etd: null });
    expect(classifyShipment(dateless, measure(), TODAY)).toBe("unknown");
  });

  it("no ETA falls back to today for the assumed entry date", () => {
    const noEta = shipment({ eta: null, sailedOnBoardDate: "2026-08-02" });
    expect(classifyShipment(noEta, measure(), TODAY)).toBe("affected");
  });
});

describe("computeImpact", () => {
  it("reports SHP-1008 with the grace deadline and money exposure", () => {
    const rows = computeImpact([shipment()], [measure(), graceRow], TODAY);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.sailDate).toBe("2026-07-16");
    expect(row.sailEstimated).toBe(false);
    // The post-cutoff row spared it — only the grace row appears.
    expect(row.perMeasure).toHaveLength(1);
    expect(row.perMeasure[0].classification).toEqual({
      sparedIfEnteredBy: "2026-08-10",
    });
    expect(row.perMeasure[0].exposureCents).toBe(100_000);
  });

  it("ETD-only shipments are flagged estimated", () => {
    const rows = computeImpact(
      [shipment({ sailedOnBoardDate: null })],
      [graceRow],
      TODAY,
    );
    expect(rows[0].sailEstimated).toBe(true);
    expect(rows[0].sailDate).toBe("2026-07-15");
  });

  it("shipments spared by every measure stay out of the report", () => {
    const early = shipment({ eta: "2026-08-05" });
    // Post-cutoff row: spared (sailed Jul 16). Grace row applies from Aug
    // 11 but ETA Aug 5 -> spared_if_entered_by — still reported.
    const rows = computeImpact([early], [measure()], TODAY);
    expect(rows).toEqual([]);
  });

  it("hts_list measures classify but never estimate money pre-entry", () => {
    const htsScoped = measure({ scope: "hts_list", sailedOnOrAfter: "2026-07-01" });
    const rows = computeImpact([shipment()], [htsScoped], TODAY);
    expect(rows[0].perMeasure[0].classification).toBe("affected");
    expect(rows[0].perMeasure[0].exposureCents).toBeNull();
  });
});

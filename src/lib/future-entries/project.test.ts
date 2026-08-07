import { describe, expect, it } from "vitest";

import { buildMeasureSeed, buildSeedReferenceData, type DayFn } from "../db/seed-data/tariff";
import type { ImpactMeasure } from "../tariff-sync/impact";
import {
  projectFutureEntries,
  type ProjectablePurchaseOrder,
  type ProjectableShipment,
} from "./project";

// Fixed anchor (2026-08-11) — see calculator.test.ts. Section 122 anchors:
// sail cutoff day(-10) = 2026-08-01, grace deadline day(+7) = 2026-08-18.
const day: DayFn = (offset) =>
  new Date(Date.UTC(2026, 7, 11) + offset * 86_400_000)
    .toISOString()
    .slice(0, 10);

const TODAY = day(0);
const ref = buildSeedReferenceData(day);

// Sail-conditioned windows in the shape queries hand the projection —
// mirrors how queries/entries.ts maps trade_measures rows.
const sailMeasures: ImpactMeasure[] = buildMeasureSeed(day)
  .filter((m) => m.sailedOnOrAfter != null || m.sailedOnOrBefore != null)
  .map((m, i) => ({
    id: `m${i}`,
    name: m.name,
    ch99Code: null,
    rate: null,
    scope: m.scope,
    effectiveDate: m.effectiveDate,
    endDate: m.endDate,
    sailedOnOrAfter: m.sailedOnOrAfter ?? null,
    sailedOnOrBefore: m.sailedOnOrBefore ?? null,
  }));

function shipment(over: Partial<ProjectableShipment>): ProjectableShipment {
  return {
    id: "s1",
    shipmentNumber: "SHP-9001",
    billOfLading: "TEST1234567",
    containerNumber: null,
    carrier: "Test Lines",
    vessel: "TEST VESSEL",
    mode: "ocean",
    originPort: "Yantian, CN",
    destinationPort: "Long Beach, CA",
    etd: day(-14),
    eta: day(4),
    sailedOnBoardDate: day(-13),
    ...over,
  };
}

const activePart = (htsCode: string, coo: string) => ({
  status: "active",
  htsCode,
  htsCodeProvisional: false,
  sources: [{ vendorId: "vendor-shenzhen", countryOfOrigin: coo }],
});

// PO-2026-009's shape: a CN motor line and a CN battery line.
function motorBatteryPo(): ProjectablePurchaseOrder {
  return {
    id: "po1",
    poNumber: "PO-9001",
    supplierName: "Shenzhen Volt Dynamics",
    vendorId: "vendor-shenzhen",
    orderDate: day(-30),
    currency: "USD",
    totalAmount: "81225.00",
    lines: [
      { sku: "EB-MTR-750W", description: "750W Mid-Drive Motor", countryOfOrigin: null, quantity: "150", unitPrice: "289.5000", totalPrice: "43425.00", part: activePart("8501.31.4000", "CN") },
      { sku: "EB-BAT-48V", description: "48V 14Ah Lithium Battery Pack", countryOfOrigin: null, quantity: "120", unitPrice: "315.0000", totalPrice: "37800.00", part: activePart("8507.60.0020", "CN") },
    ],
  };
}

function project(
  shipments: (ProjectableShipment & { purchaseOrders: ProjectablePurchaseOrder[] })[],
  enteredIds: string[] = [],
) {
  return projectFutureEntries({
    shipments,
    enteredShipmentIds: new Set(enteredIds),
    sailMeasures,
    ref,
    today: TODAY,
  });
}

describe("projectFutureEntries", () => {
  it("projects only unentered shipments still headed for customs", () => {
    const rows = project(
      [
        // Sailed (in transit), ETA ahead, no entry — projected.
        { ...shipment({ id: "a", shipmentNumber: "SHP-A" }), purchaseOrders: [] },
        // Behind an entry — excluded by the entry link.
        { ...shipment({ id: "b", shipmentNumber: "SHP-B", eta: day(-30) }), purchaseOrders: [] },
        // ETA in the past, no entry link — derived arrived, past projecting.
        { ...shipment({ id: "c", shipmentNumber: "SHP-C", eta: day(-2) }), purchaseOrders: [] },
        // Booked with no dates at all — still a future entry.
        { ...shipment({ id: "d", shipmentNumber: "SHP-D", etd: null, eta: null, sailedOnBoardDate: null }), purchaseOrders: [] },
        // ETA today — derived arrived (the goods are at port), not projected.
        { ...shipment({ id: "e", shipmentNumber: "SHP-E", eta: day(0) }), purchaseOrders: [] },
      ],
      ["b"],
    );

    expect(rows.map((r) => r.id)).toEqual(["future:a", "future:d"]);
    // ETA order, ETA-less bookings last.
    expect(rows.map((r) => r.projectedEntryDate)).toEqual([day(4), null]);
  });

  it("estimates lines, duties, and nominal fees from committed catalog data", () => {
    const [row] = project([{ ...shipment({}), purchaseOrders: [motorBatteryPo()] }]);

    expect(row.id).toBe("future:s1");
    expect(row.projectedEntryDate).toBe(day(4));
    expect(row.estimatedLines).toHaveLength(2);
    expect(row.estimatedEnteredValueCents).toBe(8_122_500);

    // Motor: base 4% + 301 List 1 25% + reciprocal 10% on $43,425.
    const motor = row.estimatedLines[0];
    expect(motor.baseDutyCents).toBe(173_700);
    expect(motor.additionalDutiesCents).toBe(1_085_625 + 434_250);
    // Battery: base 3.4% + 301 List 3 25% + reciprocal 10% on $37,800.
    const battery = row.estimatedLines[1];
    expect(battery.baseDutyCents).toBe(128_520);
    expect(battery.additionalDutiesCents).toBe(945_000 + 378_000);

    // Nominal fees on the estimated entered value; sailed before the
    // Section 122 cutoff with ETA inside the grace window, so no surcharge
    // components anywhere.
    expect(row.estimatedMpfCents).toBe(28_136);
    expect(row.estimatedHmfCents).toBe(10_153);
    expect(row.estimatedBaseDutyCents).toBe(302_220);
    expect(row.estimatedAdditionalDutiesCents).toBe(2_842_875);
    expect(row.estimatedDutiesCents).toBe(
      302_220 + 2_842_875 + 28_136 + 10_153,
    );

    // Exact BOL on-board date → exact sail basis, nothing assumed.
    expect(row.sailInfo).toEqual({
      earliestSail: day(-13),
      latestSail: day(-13),
      estimated: false,
    });
    expect(row.sailBasis).toBe("exact");
  });

  it("reports the savings-clause deadline for pre-cutoff sailings", () => {
    const [row] = project([{ ...shipment({}), purchaseOrders: [motorBatteryPo()] }]);
    expect(row.deadline).toEqual({
      measureName: "Section 122 Import Surcharge — pre-cutoff sailings past grace",
      enteredBy: day(7),
    });

    // Sailed ON the cutoff: the surcharge applies outright — no deadline
    // chip (the grace clause only covers pre-cutoff sailings).
    const [late] = project([
      { ...shipment({ sailedOnBoardDate: day(-10) }), purchaseOrders: [motorBatteryPo()] },
    ]);
    expect(late.deadline).toBeNull();
  });

  it("skips draft and provisional codes; duties null when nothing is computable", () => {
    const po: ProjectablePurchaseOrder = {
      ...motorBatteryPo(),
      lines: [
        // Draft part: nothing on it is committed — codeless for estimates.
        { sku: "EB-CHG-52V", description: "52V 4A Fast Charger", countryOfOrigin: null, quantity: "200", unitPrice: "21.7500", totalPrice: "4350.00", part: { status: "draft", htsCode: "8504.40.9550", htsCodeProvisional: false, sources: [{ vendorId: "vendor-shenzhen", countryOfOrigin: "CN" }] } },
        // Provisional code: auto-selected, unreviewed — never drives money.
        { sku: "EB-CHG-48V", description: "48V 3A Battery Charger", countryOfOrigin: null, quantity: "100", unitPrice: "18.5000", totalPrice: "1850.00", part: { status: "active", htsCode: "8504.40.9550", htsCodeProvisional: true, sources: [{ vendorId: "vendor-shenzhen", countryOfOrigin: "CN" }] } },
      ],
    };
    const [row] = project([{ ...shipment({}), purchaseOrders: [po] }]);

    // Entered value is still known from the PO…
    expect(row.estimatedEnteredValueCents).toBe(435_000 + 185_000);
    // …but with no committed code anywhere there is no duty estimate at
    // all (an entered value alone is not a duty estimate).
    expect(row.estimatedLines.every((l) => l.htsCode === null)).toBe(true);
    expect(row.estimatedBaseDutyCents).toBeNull();
    expect(row.estimatedAdditionalDutiesCents).toBeNull();
    expect(row.estimatedDutiesCents).toBeNull();
  });

  it("charges no HMF off ocean and flags ETD-estimated sail dates", () => {
    const [row] = project([
      {
        ...shipment({ mode: "air", sailedOnBoardDate: null }),
        purchaseOrders: [motorBatteryPo()],
      },
    ]);
    expect(row.estimatedMpfCents).toBe(28_136);
    expect(row.estimatedHmfCents).toBeNull();
    // No on-board date → sail resolved from ETD, flagged estimated.
    expect(row.sailInfo.estimated).toBe(true);
    expect(row.sailBasis).toBe("estimated");
  });
});

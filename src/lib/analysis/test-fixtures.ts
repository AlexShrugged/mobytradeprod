// Shared in-memory fixtures for the analysis tests: a seed-backed reference
// and one small entry bundle (base-duty-only CN motor line, so the
// deterministic rules have something to say). Test-only module.

import { buildSeedReferenceData, type DayFn } from "../db/seed-data/tariff";
import type { AuditableSnapshot } from "../audit/auditor";
import type { BundleSiblingEntry, EntryBundle } from "./types";

// Fixed anchor, same idiom as rules.test.ts.
export const day: DayFn = (offset) =>
  new Date(Date.UTC(2026, 7, 11) + offset * 86_400_000)
    .toISOString()
    .slice(0, 10);

export const fixtureRef = buildSeedReferenceData(day);

/** A sibling on the same shipment declaring the same goods WITH the CN
 *  Section 301 measure the fixture entry omits — the cross-entry
 *  inconsistency shape. */
export function fixtureSibling(): BundleSiblingEntry {
  return {
    entryNumber: "231-0000002-2",
    entryDate: day(-30),
    entryType: "01",
    totalEnteredValue: "5000.00",
    totalDuty: "1450.00",
    sharedShipments: [
      { shipmentNumber: "SHP-1001", billOfLading: "MAEU12345678", mode: "ocean" },
    ],
    lines: [
      {
        lineNumber: 1,
        sku: "EB-MTR-500W",
        description: "500W hub motors",
        htsCode: "8501.31.4000",
        spi: null,
        countryOfOrigin: "CN",
        supplierName: "Shenzhen Drivetrain Co",
        quantity: "50.0000",
        enteredValue: "5000.00",
        charges: [
          {
            chargeType: "base_duty",
            htsCode: "8501.31.4000",
            rate: "0.04",
            amount: "200.00",
          },
          {
            chargeType: "additional_duty",
            htsCode: "9903.88.01",
            rate: "0.25",
            amount: "1250.00",
          },
        ],
      },
    ],
  };
}

export function fixtureBundle(over: Partial<EntryBundle> = {}): EntryBundle {
  const snapshot: AuditableSnapshot = {
    entry: {
      id: "e1",
      entryNumber: "231-0000001-1",
      entryDate: day(-30),
      entryType: "01",
      portOfEntry: "2704",
      importerOfRecord: "Test Importer",
      totalEnteredValue: "10000.00",
      totalDuty: "400.00",
      totalBaseDuty: "400.00",
      mpfAmount: "34.64",
      hmfAmount: "12.50",
    },
    auditable: {
      entryDate: day(-30),
      totalEnteredValue: "10000.00",
      totalDuty: "400.00",
      sail: null,
      lines: [
        {
          id: "l1",
          lineNumber: 1,
          sku: "EB-MTR-500W",
          htsCode: "8501.31.4000",
          htsCodeDigits: "8501314000",
          countryOfOrigin: "CN",
          vendorId: null,
          enteredValue: "10000.00",
          quantity: "100.0000",
          partHtsCode: null,
          partHtsCodeCurrent: null,
          partHtsCurrentSince: null,
          partSources: [],
          description: "500W hub motors",
          supplierName: "Shenzhen Drivetrain Co",
          // Base duty only — the seed's CN measures are deliberately absent
          // so the deterministic rules have findings to report.
          charges: [
            {
              id: "c1",
              chargeType: "base_duty",
              htsCode: "8501.31.4000",
              htsCodeDigits: "8501314000",
              rate: "0.04",
              amount: "400.00",
            },
          ],
        },
      ],
      linkedInvoices: [],
    },
  };
  return {
    orgId: "org1",
    snapshot,
    documents: [
      {
        id: "d1",
        fileName: "7501.pdf",
        docType: "port_entry",
        status: "processed",
        packetRole: null,
        pageRange: null,
        linkedVia: [{ entityType: "entry", entityId: "e1" }],
        extractedData: { entry_number: "231-0000001-1", entry_type: "03" },
      },
    ],
    siblingEntries: [],
    partsBySku: new Map([
      [
        "EB-MTR-500W",
        {
          sku: "EB-MTR-500W",
          name: "500W hub motor",
          description: "Brushless 500W hub motor",
          status: "active",
          htsCode: "8501.31.4000",
          htsCodeProvisional: false,
          sources: [],
          classifications: [],
        },
      ],
    ]),
    adcvdOrders: [
      {
        caseNumber: "A-570-121",
        country: "CN",
        merchandise: "Lithium-Ion Battery Packs",
        scopeSummary: "Rechargeable lithium-ion battery packs, 36V+.",
        htsPrefixes: ["8507.60"],
        status: "active",
        effectiveDate: "2023-05-18",
        revokedDate: null,
        depositRates: [
          { producer: "Shenzhen Volt Dynamics", rate: 0.1783 },
          { producer: null, rate: 0.2547 },
        ],
        source: "test",
      },
      {
        caseNumber: "A-570-133",
        country: "CN",
        merchandise: "Electric Bicycle Hub Motors",
        scopeSummary: "Brushless DC hub motors, 250W-1000W.",
        htsPrefixes: ["8501.31", "8501.32"],
        status: "active",
        effectiveDate: "2024-02-09",
        revokedDate: null,
        depositRates: [{ producer: null, rate: 0.6842 }],
        source: "test",
      },
    ],
    orgRules: [],
    ...over,
  };
}

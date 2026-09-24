import { describe, expect, it } from "vitest";

import type {
  CommercialInvoiceExtraction,
  ExtractionCitations,
  FieldCitation,
  PortEntryExtraction,
} from "@/lib/processing/types";
import {
  planEntryCitations,
  planInvoiceCitations,
  type StoredEntry,
  type StoredInvoice,
} from "./citation-backfill";

const cite = (printed: string, page = 1): FieldCitation => ({
  boxes: [{ page, left: 0.1, top: 0.2, width: 0.3, height: 0.02 }],
  printed,
});

const extraction: PortEntryExtraction = {
  entry_number: "231-4501287-4",
  entry_date: "2026-07-01",
  port_of_entry: "Los Angeles, CA",
  entry_type: "01",
  importer_of_record: null,
  referenced_bols: [],
  referenced_pos: [],
  referenced_invoices: [],
  total_entered_value: 15750,
  total_duty: 2756.25,
  mpf_amount: 54.62,
  hmf_amount: null,
  bond_type: "continuous",
  line_items: [
    {
      line_number: 1,
      sku: "EB-HUB-250",
      description: "Rear hub motor",
      hts_code: "8501.31.4000",
      country_of_origin: "CN",
      supplier_name: null,
      quantity: 100,
      unit_value: 105,
      entered_value: 10500,
      charges: [
        { charge_type: "base_duty", hts_code: null, rate: 0.028, amount: 294 },
        {
          charge_type: "additional_duty",
          hts_code: "9903.88.01",
          rate: 0.25,
          amount: 2625,
        },
      ],
    },
    {
      line_number: 2,
      sku: null,
      description: null,
      hts_code: "8714.91.3000",
      country_of_origin: "TW",
      supplier_name: null,
      quantity: 50,
      unit_value: null,
      entered_value: 5250,
      charges: [],
    },
  ],
};

const citations: ExtractionCitations = {
  header: {
    entry_number: cite("231-4501287-4"),
    mpf_amount: cite("54.62"),
    bond_type: cite("CONTINUOUS"),
  },
  lines: [
    {
      fields: {
        hts_code: cite("8501.31.4000"),
        sku: cite("EB-HUB-250"),
        entered_value: cite("$10,500.00"),
        quantity: cite("100"),
      },
      charges: [
        { rate: cite("2.8%"), amount: cite("294.00") },
        { hts_code: cite("9903.88.01"), amount: cite("2,625.00"), rate: cite("25%") },
      ],
    },
    {
      fields: { hts_code: cite("8714.91.3000", 2), quantity: cite("50", 2) },
      charges: [],
    },
  ],
};

const stored: StoredEntry = {
  id: "entry-1",
  entryNumber: "231-4501287-4",
  entryDate: "2026-07-01",
  portOfEntry: "Los Angeles, CA",
  entryType: "01",
  importerOfRecord: null,
  totalEnteredValue: "15750.00",
  totalDuty: "2756.25",
  // Block 43 governed the stored fee: the extractor's leaf must not back it.
  mpfAmount: "33.58",
  hmfAmount: null,
  lines: [
    {
      id: "line-1",
      lineNumber: 1,
      // Scrubbed after extraction: the citation must not survive.
      sku: null,
      description: "Rear hub motor",
      htsCode: "8501.31.4000",
      spi: null,
      countryOfOrigin: "CN",
      supplierName: null,
      quantity: "100.0000",
      quantityUnit: null,
      unitValue: "105.0000",
      enteredValue: "10500.00",
      charges: [
        { id: "ch-1", chargeType: "base_duty", htsCode: null, rate: "0.028000", amount: "294.00" },
        { id: "ch-2", chargeType: "additional_duty", htsCode: "9903.88.01", rate: "0.250000", amount: "2625.00" },
      ],
    },
    {
      id: "line-2",
      lineNumber: 2,
      sku: null,
      description: null,
      htsCode: "8714.91.3000",
      spi: null,
      countryOfOrigin: "TW",
      supplierName: null,
      // Blanked as a mirrored quantity: uncited.
      quantity: null,
      quantityUnit: null,
      unitValue: null,
      enteredValue: "5250.00",
      charges: [],
    },
  ],
};

describe("planEntryCitations", () => {
  it("plans citations only where the stored value still equals the mapped one", () => {
    const plan = planEntryCitations(extraction, citations, stored);
    const keys = plan.rows.map((r) => `${r.entityType}:${r.entityId}:${r.field}`);
    expect(keys).toEqual([
      "entry:entry-1:entry_number",
      // bond_type is document-only: nothing stored to contradict it.
      "entry:entry-1:bond_type",
      "entry_line_item:line-1:hts_code",
      "entry_line_item:line-1:entered_value",
      "entry_line_item:line-1:quantity",
      "entry_line_charge:ch-1:rate",
      "entry_line_charge:ch-1:amount",
      "entry_line_charge:ch-2:hts_code",
      "entry_line_charge:ch-2:amount",
      "entry_line_charge:ch-2:rate",
      "entry_line_item:line-2:hts_code",
    ]);
    expect(plan.skipped).toEqual([
      "entry 231-4501287-4.mpf_amount: stored 33.58 ≠ mapped 54.62",
      "line 1.sku: stored null ≠ mapped EB-HUB-250",
      "line 2.quantity: stored null ≠ mapped 50",
    ]);
    const second = plan.rows.find((r) => r.entityId === "line-2");
    expect(second?.page).toBe(2);
    expect(second?.printed).toBe("8714.91.3000");
  });

  it("skips a line whose stored facts no longer match, and a charge stack of another shape", () => {
    const plan = planEntryCitations(extraction, citations, {
      ...stored,
      lines: [
        { ...stored.lines[0], enteredValue: "8070.00" },
        {
          ...stored.lines[1],
          charges: [
            { id: "ch-9", chargeType: "base_duty", htsCode: null, rate: null, amount: "0.00" },
          ],
        },
      ],
    });
    expect(plan.rows.map((r) => r.entityId)).toEqual(["entry-1", "entry-1", "line-2"]);
    expect(plan.skipped).toContain(
      "line 1: stored 8501.31.4000 @ 8070.00 ≠ mapped 8501.31.4000 @ 10500",
    );
    expect(plan.skipped).toContain("line 2 charges: stored 1 ≠ mapped 0");
  });

  it("skips a same-length stack whose positions disagree", () => {
    const plan = planEntryCitations(extraction, citations, {
      ...stored,
      lines: [
        {
          ...stored.lines[0],
          charges: [stored.lines[0].charges[1], stored.lines[0].charges[0]],
        },
        stored.lines[1],
      ],
    });
    expect(plan.rows.some((r) => r.entityType === "entry_line_charge")).toBe(false);
    expect(plan.skipped).toContain("line 1 charges: stack differs");
  });
});

describe("planInvoiceCitations", () => {
  const invoice: CommercialInvoiceExtraction = {
    invoice_number: "SVD-8841",
    po_number: "PO-1",
    supplier_name: "Volt",
    invoice_date: "2026-06-20",
    currency: "USD",
    amount: 41900,
    subtotal: null,
    adjustments: [],
    incoterms: "FOB",
    line_items: [
      {
        line_number: 1,
        sku: "EB-BAT-48V",
        description: null,
        country_of_origin: "CN",
        hts_code: "850760",
        quantity: 100,
        unit_price: 312,
        total_price: 31200,
      },
    ],
  };
  const cited: ExtractionCitations = {
    header: { invoice_number: cite("SVD-8841"), amount: cite("$41,900.00") },
    lines: [
      {
        fields: { hts_code: cite("850760"), total_price: cite("$31,200.00") },
        charges: [],
      },
    ],
  };
  const storedInvoice: StoredInvoice = {
    id: "inv-1",
    invoiceNumber: "SVD-8841",
    supplierName: "Volt",
    invoiceDate: "2026-06-20",
    currency: "USD",
    totalAmount: "41900.00",
    subtotal: null,
    incoterms: "FOB",
    lines: [
      {
        id: "il-1",
        lineNumber: 1,
        sku: "EB-BAT-48V",
        description: null,
        countryOfOrigin: "CN",
        // Stored in canonical dotted form: the digits are what must agree.
        htsCode: "8507.60",
        quantity: "100.0000",
        quantityUnit: null,
        unitPrice: "312.0000",
        totalPrice: "31200.00",
      },
    ],
  };

  it("plans header and line citations, comparing HTS codes by digits", () => {
    const plan = planInvoiceCitations(invoice, cited, storedInvoice);
    expect(plan.rows.map((r) => `${r.entityType}:${r.entityId}:${r.field}`)).toEqual([
      "invoice:inv-1:invoice_number",
      "invoice:inv-1:amount",
      "invoice_line_item:il-1:hts_code",
      "invoice_line_item:il-1:total_price",
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it("skips a line whose stored total differs", () => {
    const plan = planInvoiceCitations(invoice, cited, {
      ...storedInvoice,
      lines: [{ ...storedInvoice.lines[0], totalPrice: "10700.00" }],
    });
    expect(plan.rows.map((r) => r.entityType)).toEqual(["invoice", "invoice"]);
    expect(plan.skipped).toEqual([
      "invoice line 1: stored total 10700.00 ≠ mapped 31200",
    ]);
  });
});

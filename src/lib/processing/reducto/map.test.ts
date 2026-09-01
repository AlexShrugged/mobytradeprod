import { describe, expect, it } from "vitest";

import { ProcessingError } from "../types";
import {
  cite,
  CLASSIFY_RESPONSE,
  CLASSIFY_RESPONSE_ASSIST,
  CLASSIFY_RESPONSE_INVALID,
  CLASSIFY_RESPONSE_PACKET,
  COMMERCIAL_INVOICE_RESPONSE,
  PACKING_LIST_RESPONSE,
  PORT_ENTRY_RESPONSE,
  PORT_ENTRY_RESPONSE_CH99_SPLIT,
  PORT_ENTRY_RESPONSE_NO_NUMBER,
  PURCHASE_ORDER_RESPONSE,
  QUOTE_SHEET_RESPONSE,
  QUOTE_SHEET_RESPONSE_EMPTY,
  REFUND_REPORT_RESPONSE,
  SHIPMENT_RESPONSE,
} from "./fixtures";
import {
  classifyFromResponse,
  mapExtractToResult,
  mergeResultChunks,
  unwrapCitations,
} from "./map";

describe("unwrapCitations", () => {
  it("unwraps cited scalars, including empty citation arrays", () => {
    expect(unwrapCitations(cite("abc"))).toBe("abc");
    expect(unwrapCitations(cite(42, false))).toBe(42);
    expect(unwrapCitations(cite(null))).toBeNull();
  });

  it("recurses through arrays and nested objects", () => {
    const nested = {
      a: cite("x"),
      list: [cite(1), cite(2)],
      obj: { inner: cite("y") },
    };
    expect(unwrapCitations(nested)).toEqual({
      a: "x",
      list: [1, 2],
      obj: { inner: "y" },
    });
  });

  it("is a no-op on plain uncited data", () => {
    const plain = { doc_type: "shipment", n: 3, list: ["a"] };
    expect(unwrapCitations(plain)).toEqual(plain);
  });

  it("does not unwrap objects with a value key but no citations array", () => {
    const notCited = { value: 10, unit: "kg" };
    expect(unwrapCitations(notCited)).toEqual(notCited);
  });
});

describe("mergeResultChunks", () => {
  it("merges multiple chunk objects left to right", () => {
    expect(mergeResultChunks([{ a: 1 }, { b: 2 }, { a: 3 }])).toEqual({
      a: 3,
      b: 2,
    });
  });

  it("wraps a bare object", () => {
    expect(mergeResultChunks({ a: 1 })).toEqual({ a: 1 });
  });
});

describe("classifyFromResponse", () => {
  it("returns a valid extracted doc type", () => {
    expect(classifyFromResponse(CLASSIFY_RESPONSE, "other")).toBe("port_entry");
  });

  it("accepts the new quote_sheet type", () => {
    expect(classifyFromResponse([{ doc_type: "quote_sheet" }], "other")).toBe(
      "quote_sheet",
    );
  });

  it("falls back to the hint on an invalid value", () => {
    expect(classifyFromResponse(CLASSIFY_RESPONSE_INVALID, "shipment")).toBe(
      "shipment",
    );
  });

  it("passes entry_packet through (it is a real docType)", () => {
    expect(classifyFromResponse(CLASSIFY_RESPONSE_PACKET, "port_entry")).toBe(
      "entry_packet",
    );
  });

  it("maps the classification-only assist_sheet label to other", () => {
    // Protects standalone assist-sheet uploads from the commercial_invoice
    // pipeline — an assist sheet must never become an Invoice.
    expect(
      classifyFromResponse(CLASSIFY_RESPONSE_ASSIST, "commercial_invoice"),
    ).toBe("other");
  });

  it("maps the classification-only broker_invoice label to other", () => {
    // A broker's own bill is USD and cites exactly one entry, so it would
    // pass every variance gate if it ever became a commercial_invoice.
    expect(
      classifyFromResponse([{ doc_type: "broker_invoice" }], "commercial_invoice"),
    ).toBe("other");
  });

  it("falls back to other when the hint is other", () => {
    expect(classifyFromResponse([{}], "other")).toBe("other");
  });
});

describe("port_entry mapping", () => {
  const result = mapExtractToResult("port_entry", PORT_ENTRY_RESPONSE);
  if (result.docType !== "port_entry") throw new Error("wrong docType");
  const f = result.fields;

  it("maps header fields and coerces stringified currency", () => {
    expect(f.entry_number).toBe("231-4501287-4");
    expect(f.entry_date).toBe("2026-07-01");
    expect(f.total_entered_value).toBe(15750);
    expect(f.total_duty).toBe(2756.25);
    expect(f.hmf_amount).toBe(19.69);
    expect(f.referenced_bols).toEqual(["MAEU2264101", "ONEY8811327"]);
    expect(f.referenced_pos).toEqual(["PO-2026-001"]);
    expect(f.referenced_invoices).toEqual(["SVD-8841"]);
  });

  it("captures the compliance fields (AD/CVD, bond, MID, related-party)", () => {
    expect(f.adcvd_case_numbers).toEqual(["A-570-121"]);
    expect(f.bond_type).toBe("continuous");
    expect(f.surety_number).toBe("128");
    // "No" on the form coerces to boolean false.
    expect(f.related_party).toBe(false);
    expect(f.line_items[0].adcvd_case_number).toBe("A-570-121");
    expect(f.line_items[0].manufacturer_id).toBe("CNSHEVOL123SHE");
    // Lines that show none map to null, not undefined.
    expect(f.line_items[1].adcvd_case_number).toBeNull();
  });

  it("defaults referenced_invoices to [] when the entry logs none", () => {
    const split = mapExtractToResult(
      "port_entry",
      PORT_ENTRY_RESPONSE_CH99_SPLIT,
    );
    if (split.docType !== "port_entry") throw new Error("wrong docType");
    expect(split.fields.referenced_invoices).toEqual([]);
  });

  it("drops lines without an HTS code and numbers unnumbered lines", () => {
    expect(f.line_items).toHaveLength(2);
    expect(f.line_items[0].line_number).toBe(1);
    expect(f.line_items[1].line_number).toBe(2);
    expect(f.line_items[1].hts_code).toBe("8714.91.3000");
    expect(f.line_items[1].charges).toEqual([]);
  });

  it("uppercases COO and captures the per-line supplier", () => {
    // "cn" in the document — downstream measure gating is exact-match.
    expect(f.line_items[0].country_of_origin).toBe("CN");
    expect(f.line_items[0].supplier_name).toBe("Shenzhen Volt Dynamics");
    expect(f.line_items[1].supplier_name).toBeNull();
  });

  it("coerces charge rates/amounts and clamps unknown charge types", () => {
    const charges = f.line_items[0].charges;
    expect(charges[0].charge_type).toBe("base_duty");
    expect(charges[0].rate).toBeCloseTo(0.028);
    expect(charges[1].charge_type).toBe("additional_duty");
    expect(charges[1].hts_code).toBe("9903.88.01");
    // "section 301 tariff" is not in the pg enum — clamped, $0 preserved.
    expect(charges[2].charge_type).toBe("other_fee");
    expect(charges[2].amount).toBe(0);
    expect(charges[3].charge_type).toBe("mpf");
  });

  it("folds Ch99 rows sharing a line number into the base line's charges", () => {
    const split = mapExtractToResult(
      "port_entry",
      PORT_ENTRY_RESPONSE_CH99_SPLIT,
    );
    if (split.docType !== "port_entry") throw new Error("wrong docType");
    const lines = split.fields.line_items;

    // Three extracted rows for line 1 collapse into one line item.
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.line_number)).toEqual([1, 2]);

    // The non-Ch99 row keeps the goods facts; the duty basis repeated on
    // supplemental rows is not summed.
    const line1 = lines[0];
    expect(line1.hts_code).toBe("8711.60.0050");
    expect(line1.quantity).toBe(25);
    expect(line1.entered_value).toBe(6250);

    // Supplemental charges fold in: the uncoded charge inherits its row's
    // Ch99 code, and the charge-less exclusion row survives as $0 under
    // its own code.
    expect(line1.charges).toEqual([
      { charge_type: "base_duty", hts_code: null, rate: 0, amount: 0 },
      {
        charge_type: "additional_duty",
        hts_code: "9903.05.31",
        rate: 0.075,
        amount: 468.75,
      },
      {
        charge_type: "additional_duty",
        hts_code: "9903.88.67",
        rate: null,
        amount: 0,
      },
    ]);

    expect(lines[1].hts_code).toBe("8504.40.9520");
    expect(lines[1].charges).toHaveLength(1);
  });

  it("throws a readable ProcessingError when the entry number is missing", () => {
    expect(() =>
      mapExtractToResult("port_entry", PORT_ENTRY_RESPONSE_NO_NUMBER),
    ).toThrow(ProcessingError);
    expect(() =>
      mapExtractToResult("port_entry", PORT_ENTRY_RESPONSE_NO_NUMBER),
    ).toThrow(/entry number/);
  });
});

describe("shipment mapping", () => {
  it("maps and normalizes dates", () => {
    const result = mapExtractToResult("shipment", SHIPMENT_RESPONSE);
    if (result.docType !== "shipment") throw new Error("wrong docType");
    expect(result.fields.bill_of_lading).toBe("MAEU2264101");
    expect(result.fields.etd).toBe("2026-06-15");
    expect(result.fields.eta).toBe("2026-07-02");
    expect(result.fields.shipped_on_board_date).toBe("2026-06-16");
    expect(result.fields.referenced_pos).toEqual([
      "PO-2026-001",
      "PO-2026-002",
    ]);
  });

  it("captures the shipper and consignee parties", () => {
    const result = mapExtractToResult("shipment", SHIPMENT_RESPONSE);
    if (result.docType !== "shipment") throw new Error("wrong docType");
    expect(result.fields.shipper_name).toBe("Shenzhen Volt Dynamics");
    expect(result.fields.consignee_name).toBe("Waystar Royco, Inc.");
  });

  it("throws when the bill of lading is missing", () => {
    expect(() => mapExtractToResult("shipment", [{}])).toThrow(
      /bill of lading/,
    );
  });
});

describe("purchase_order mapping", () => {
  it("defaults currency to USD, drops SKU-less lines, keeps document positions", () => {
    const result = mapExtractToResult(
      "purchase_order",
      PURCHASE_ORDER_RESPONSE,
    );
    if (result.docType !== "purchase_order") throw new Error("wrong docType");
    expect(result.fields.po_number).toBe("PO-2026-003");
    expect(result.fields.currency).toBe("USD");
    expect(result.fields.total_amount).toBe(42000);
    expect(result.fields.line_items).toEqual([
      {
        line_number: 1,
        sku: "EB-BAT-48",
        description: "48V battery pack",
        // "cn" in the document — uppercased on map.
        country_of_origin: "CN",
        quantity: 200,
        unit_price: 180,
      },
      // The SKU-less line is dropped; the unnumbered line keeps its
      // document position (3) and its stringified numbers coerce.
      {
        line_number: 3,
        sku: "EB-CTRL-V2",
        description: null,
        country_of_origin: null,
        quantity: 50,
        unit_price: 42.3,
      },
    ]);
  });
});

describe("commercial_invoice mapping", () => {
  it("maps all fields", () => {
    const result = mapExtractToResult(
      "commercial_invoice",
      COMMERCIAL_INVOICE_RESPONSE,
    );
    if (result.docType !== "commercial_invoice")
      throw new Error("wrong docType");
    expect(result.fields).toEqual({
      invoice_number: "SVD-8841",
      po_number: "PO-2026-003",
      supplier_name: "Shenzhen Volt Dynamics Co.",
      invoice_date: "2026-06-20",
      currency: "USD",
      amount: 41900,
      incoterms: "FOB Yantian",
      payment_terms: "T/T 30 days",
      related_party: false,
      line_items: [
        {
          line_number: 1,
          sku: "EB-BAT-48V",
          description: "48V 14Ah Lithium Battery Pack",
          country_of_origin: "CN",
          // The 6-digit HS code as printed — kept verbatim.
          hts_code: "850760",
          quantity: 100,
          unit_price: 312,
          total_price: 31200,
          adcvd_case_number: "A-570-133",
          manufacturer_name: "Dongguan PowerCell Manufacturing",
        },
        // The no-total line is dropped; the SKU-only line keeps its total
        // and falls back to its position for line_number.
        {
          line_number: 3,
          sku: "EB-MTR-500W",
          description: null,
          country_of_origin: null,
          hts_code: null,
          quantity: null,
          unit_price: null,
          total_price: 10700,
          adcvd_case_number: null,
          manufacturer_name: null,
        },
      ],
    });
  });
});

describe("packing_list mapping", () => {
  it("coerces stringified counts and weights", () => {
    const result = mapExtractToResult("packing_list", PACKING_LIST_RESPONSE);
    if (result.docType !== "packing_list") throw new Error("wrong docType");
    expect(result.fields.cartons).toBe(312);
    expect(result.fields.gross_weight_kg).toBe(4180.5);
  });

  it("defaults everything on an empty response (no required identifier)", () => {
    const result = mapExtractToResult("packing_list", [{}]);
    if (result.docType !== "packing_list") throw new Error("wrong docType");
    expect(result.fields).toEqual({
      bill_of_lading: null,
      cartons: null,
      gross_weight_kg: null,
      referenced_pos: [],
    });
  });
});

describe("quote_sheet mapping", () => {
  it("maps sheet fields and coerces cited/stringified values", () => {
    const result = mapExtractToResult("quote_sheet", QUOTE_SHEET_RESPONSE);
    if (result.docType !== "quote_sheet") throw new Error("wrong docType");
    const f = result.fields;
    expect(f.supplier_name).toBe("Hangzhou Comfort Components");
    // US-format date — must normalize.
    expect(f.quote_date).toBe("2026-07-10");
    expect(f.currency).toBe("USD");
    expect(f.valid_until).toBe("2026-10-08");
    expect(f.notes).toMatch(/FOB Shanghai/);
  });

  it("drops lines missing a SKU or unit cost, keeps document positions", () => {
    const result = mapExtractToResult("quote_sheet", QUOTE_SHEET_RESPONSE);
    if (result.docType !== "quote_sheet") throw new Error("wrong docType");
    const lines = result.fields.line_items;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      line_number: 1,
      sku: "EB-SDL-CMF",
      description: "Comfort gel saddle, steel rails",
      // "$9.15" — stringified currency must coerce.
      unit_cost: 9.15,
      currency: null,
      country_of_origin: "CN",
      hts_code: "8714.95.0000",
      moq: 500,
      lead_time_days: 28,
      unit_of_measure: "EA",
    });
    // The unnumbered line keeps its document position (2).
    expect(lines[1].line_number).toBe(2);
    expect(lines[1].sku).toBe("EB-RCK-ALU");
    expect(lines[1].unit_cost).toBe(17.4);
    expect(lines[1].hts_code).toBeNull();
    expect(lines[1].lead_time_days).toBeNull();
  });

  it("throws when no usable quoted lines are found", () => {
    expect(() =>
      mapExtractToResult("quote_sheet", QUOTE_SHEET_RESPONSE_EMPTY),
    ).toThrow(ProcessingError);
    expect(() =>
      mapExtractToResult("quote_sheet", QUOTE_SHEET_RESPONSE_EMPTY),
    ).toThrow(/quoted line items/);
  });
});

describe("refund_report mapping", () => {
  it("maps claims with null-safe amounts", () => {
    const result = mapExtractToResult("refund_report", REFUND_REPORT_RESPONSE);
    if (result.docType !== "refund_report") throw new Error("wrong docType");
    expect(result.fields.report_date).toBe("2026-07-15");
    expect(result.fields.claims).toHaveLength(2);
    expect(result.fields.claims[0].refund_class_amount).toBe(4812.5);
    expect(result.fields.claims[1].refund_class_amount).toBe(0);
    expect(result.fields.claims[1].refund_interest_amount).toBe(0);
    expect(result.fields.claims[1].refund_status).toBeNull();
  });

  it("throws when no claims are found", () => {
    expect(() => mapExtractToResult("refund_report", [{ claims: [] }])).toThrow(
      /refund claims/,
    );
  });
});

describe("tariff_code_sheet mapping", () => {
  const row = (over: Record<string, unknown>) => ({
    entry_line_number: 1,
    part_number: "0890073182",
    po_number: "7043539618",
    description: null,
    ...over,
  });

  it("maps rows and collapses the stacked-Ch99 repetition", () => {
    const result = mapExtractToResult("tariff_code_sheet", [
      {
        entry_number: "231-7379174-7",
        broker_ref: "7077821743",
        referenced_invoices: ["MD2610468"],
        rows: [
          row({}),
          row({}), // same (line, part) printed once per tariff number
          row({ part_number: "0890073182 " }), // padding twin dedupes too
          row({ entry_line_number: 2, part_number: "0890071160" }),
        ],
      },
    ]);
    if (result.docType !== "tariff_code_sheet") throw new Error("wrong docType");
    expect(result.fields.entry_number).toBe("231-7379174-7");
    expect(result.fields.referenced_invoices).toEqual(["MD2610468"]);
    expect(result.fields.rows).toEqual([
      {
        entry_line_number: 1,
        part_number: "0890073182",
        po_number: "7043539618",
        description: null,
      },
      {
        entry_line_number: 2,
        part_number: "0890071160",
        po_number: "7043539618",
        description: null,
      },
    ]);
  });

  it("drops tariff numbers leaking into the part column and lineless rows", () => {
    const result = mapExtractToResult("tariff_code_sheet", [
      {
        entry_number: "231-7379174-7",
        rows: [
          row({}),
          row({ part_number: "9903.88.03" }),
          row({ part_number: "7307.19.3040" }),
          row({ entry_line_number: null, part_number: "REAL-PART" }),
        ],
      },
    ]);
    if (result.docType !== "tariff_code_sheet") throw new Error("wrong docType");
    expect(result.fields.rows.map((r) => r.part_number)).toEqual([
      "0890073182",
    ]);
  });

  it("throws when no usable rows are found", () => {
    expect(() =>
      mapExtractToResult("tariff_code_sheet", [
        { entry_number: "231-7379174-7", rows: [] },
      ]),
    ).toThrow(/line-to-part rows/);
  });
});

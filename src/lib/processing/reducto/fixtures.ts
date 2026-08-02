// Realistic Reducto extract responses for mapper tests. Shapes mirror the
// live API: `result` is an array of chunk objects; with citations enabled
// every scalar arrives as { value, citations: [...] } (citations may be
// empty for inferred values), and numbers sometimes come back as printed
// strings ("$1,575.00", "25%").

type Cited<T> = { value: T; citations: unknown[] };

export function cite<T>(value: T, withCitation = true): Cited<T> {
  return {
    value,
    citations: withCitation
      ? [
          {
            type: "text",
            content: String(value),
            bbox: { left: 0.1, top: 0.2, width: 0.3, height: 0.02, page: 1 },
            confidence: "high",
            granular_confidence: {
              extract_confidence: 0.97,
              parse_confidence: 0.99,
            },
          },
        ]
      : [],
  };
}

export const PORT_ENTRY_RESPONSE = [
  {
    entry_number: cite("231-4501287-4"),
    entry_date: cite("2026-07-01"),
    port_of_entry: cite("Los Angeles, CA"),
    entry_type: cite("01"),
    importer_of_record: cite("Countless Industries, Inc."),
    referenced_bols: [cite("MAEU2264101"), cite("ONEY8811327")],
    referenced_pos: [cite("PO-2026-001")],
    // Stringified currency — must coerce to 15750.
    total_entered_value: cite("$15,750.00"),
    total_duty: cite(2756.25),
    mpf_amount: cite(54.62),
    // Inferred value with no citation.
    hmf_amount: cite(19.69, false),
    line_items: [
      {
        line_number: cite(1),
        sku: cite("EB-HUB-250"),
        description: cite("Rear hub motor 250W"),
        hts_code: cite("8501.31.4000"),
        country_of_origin: cite("CN"),
        quantity: cite(100),
        unit_value: cite("$105.00"),
        entered_value: cite("$10,500.00"),
        charges: [
          {
            charge_type: cite("base_duty"),
            hts_code: cite(null),
            // Percent-formatted rate — must coerce to 0.028.
            rate: cite("2.8%"),
            amount: cite(294),
          },
          {
            charge_type: cite("additional_duty"),
            hts_code: cite("9903.88.01"),
            rate: cite(0.25),
            amount: cite(2625),
          },
          {
            // Not a valid charge_type enum value — must clamp to other_fee.
            charge_type: cite("section 301 tariff"),
            hts_code: cite("9903.88.01"),
            rate: cite(null),
            amount: cite("$0.00"),
          },
          {
            charge_type: cite("mpf"),
            hts_code: cite("499"),
            rate: cite(0.003464),
            amount: cite(36.37),
          },
        ],
      },
      {
        // No line_number in the document — mapper assigns index + 1.
        sku: cite(null),
        description: cite("Alloy frame"),
        hts_code: cite("8714.91.3000"),
        country_of_origin: cite("TW"),
        quantity: cite(50),
        unit_value: cite(105),
        entered_value: cite(5250),
        charges: [],
      },
      {
        // No HTS code — cannot be a declaration line; mapper drops it.
        description: cite("Freight and insurance"),
        entered_value: cite(300),
        charges: [],
      },
    ],
  },
];

// A real-world 7501 shape: the extraction returns a line's Chapter 99
// supplemental rows as separate line_items sharing the base row's line
// number (as ACE prints them). The mapper must fold them into the base
// line's charges — never emit two line_items with one line number.
export const PORT_ENTRY_RESPONSE_CH99_SPLIT = [
  {
    entry_number: cite("655-3083217-9"),
    entry_date: cite("2026-07-28"),
    port_of_entry: cite("Long Beach, CA"),
    entry_type: cite("01"),
    importer_of_record: cite("Countless Industries, Inc."),
    referenced_bols: [cite("MAEU2264109")],
    referenced_pos: [],
    total_entered_value: cite("$8,750.00"),
    total_duty: cite(688.9),
    mpf_amount: cite(30.31),
    hmf_amount: cite(null),
    line_items: [
      {
        line_number: cite(1),
        sku: cite(null),
        description: cite("Electric bicycles"),
        hts_code: cite("8711.60.0050"),
        country_of_origin: cite("CN"),
        quantity: cite(25),
        unit_value: cite(250),
        entered_value: cite(6250),
        charges: [
          {
            charge_type: cite("base_duty"),
            hts_code: cite(null),
            rate: cite(0),
            amount: cite(0),
          },
        ],
      },
      {
        // Ch99 supplemental row under the SAME line number; its charge
        // carries no hts_code of its own and must inherit 9903.05.31.
        line_number: cite(1),
        sku: cite(null),
        description: cite("PRDTS OF CHINA, NOTE 52"),
        hts_code: cite("9903.05.31"),
        country_of_origin: cite("CN"),
        quantity: cite(null),
        unit_value: cite(null),
        // Duty basis (the base line's value again) — must not be summed.
        entered_value: cite(6250),
        charges: [
          {
            charge_type: cite("additional_duty"),
            hts_code: cite(null),
            rate: cite("7.5%"),
            amount: cite(468.75),
          },
        ],
      },
      {
        // Ch99 exclusion row with no charges — survives as a $0
        // additional_duty charge under its code.
        line_number: cite(1),
        sku: cite(null),
        description: cite("SEC 301 EXCLUSION"),
        hts_code: cite("9903.88.67"),
        country_of_origin: cite(null),
        quantity: cite(null),
        unit_value: cite(null),
        entered_value: cite(6250),
        charges: [],
      },
      {
        line_number: cite(2),
        sku: cite("EB-CHG-STD"),
        description: cite("Battery chargers"),
        hts_code: cite("8504.40.9520"),
        country_of_origin: cite("VN"),
        quantity: cite(100),
        unit_value: cite(25),
        entered_value: cite(2500),
        charges: [
          {
            charge_type: cite("base_duty"),
            hts_code: cite(null),
            rate: cite("1.5%"),
            amount: cite(37.5),
          },
        ],
      },
    ],
  },
];

export const SHIPMENT_RESPONSE = [
  {
    bill_of_lading: cite("MAEU2264101"),
    container_number: cite("MSKU8801992"),
    carrier: cite("Maersk"),
    vessel: cite("Emma Maersk"),
    origin_port: cite("Yantian"),
    destination_port: cite("Los Angeles"),
    // US-format date — must normalize.
    etd: cite("06/15/2026"),
    eta: cite("2026-07-02T00:00:00Z"),
    shipped_on_board_date: cite("June 16, 2026"),
    referenced_pos: [cite("PO-2026-001"), cite("PO-2026-002")],
  },
];

export const PURCHASE_ORDER_RESPONSE = [
  {
    po_number: cite("PO-2026-003"),
    supplier_name: cite("Shenzhen Volt Drive Co."),
    order_date: cite("2026-05-20"),
    currency: cite(null),
    total_amount: cite("$42,000.00"),
    line_items: [
      {
        line_number: cite(1),
        sku: cite("EB-BAT-48"),
        description: cite("48V battery pack"),
        quantity: cite(200),
        unit_price: cite(180),
      },
      // Missing SKU — dropped.
      { quantity: cite(10), unit_price: cite(12) },
      {
        // No line_number — mapper falls back to the document position (3).
        sku: cite("EB-CTRL-V2"),
        quantity: cite("50"),
        unit_price: cite("$42.30"),
      },
    ],
  },
];

export const COMMERCIAL_INVOICE_RESPONSE = [
  {
    invoice_number: cite("SVD-8841"),
    po_number: cite("PO-2026-003"),
    supplier_name: cite("Shenzhen Volt Dynamics Co."),
    invoice_date: cite("2026-06-20"),
    currency: cite("USD"),
    amount: cite("$41,900.00"),
    incoterms: cite("FOB Yantian"),
    line_items: [
      {
        line_number: cite("1"),
        sku: cite("EB-BAT-48V"),
        description: cite("48V 14Ah Lithium Battery Pack"),
        quantity: cite("100"),
        unit_price: cite("$312.00"),
        total_price: cite("$31,200.00"),
      },
      // No extended total — dropped (nothing to reconcile against).
      { sku: cite("EB-CTRL-V2"), quantity: cite(10), unit_price: cite(42.3) },
      {
        sku: cite("EB-MTR-500W"),
        total_price: cite("$10,700.00"),
      },
    ],
  },
];

export const PACKING_LIST_RESPONSE = [
  {
    bill_of_lading: cite("ONEY8811327"),
    cartons: cite("312"),
    gross_weight_kg: cite("4,180.5"),
    referenced_pos: [cite("PO-2026-002")],
  },
];

// Two quoted parts: a known catalog SKU (a re-quote) and an unknown SKU
// whose ingestion exercises draft-part creation.
export const QUOTE_SHEET_RESPONSE = [
  {
    supplier_name: cite("Hangzhou Comfort Components"),
    quote_date: cite("07/10/2026"),
    currency: cite("USD"),
    valid_until: cite("2026-10-08"),
    notes: cite("FOB Shanghai. Tooling amortized over first 5,000 units."),
    line_items: [
      {
        line_number: cite(1),
        sku: cite("EB-SDL-CMF"),
        description: cite("Comfort gel saddle, steel rails"),
        // Stringified currency — must coerce to 9.15.
        unit_cost: cite("$9.15"),
        currency: cite(null),
        country_of_origin: cite("CN"),
        // Supplier's claimed HTS — captured verbatim, never authoritative.
        hts_code: cite("8714.95.0000"),
        moq: cite("500"),
        lead_time_days: cite(28),
        unit_of_measure: cite("EA"),
      },
      {
        // No line_number — mapper falls back to the document position (2).
        sku: cite("EB-RCK-ALU"),
        description: cite("Aluminum rear cargo rack"),
        unit_cost: cite(17.4),
        currency: cite(null),
        country_of_origin: cite("CN"),
        hts_code: cite(null),
        moq: cite(200),
        lead_time_days: cite(null),
        unit_of_measure: cite("EA"),
      },
      // No unit cost — quotes nothing ingestible; dropped.
      {
        sku: cite("EB-RCK-STL"),
        description: cite("Steel rack (tooling pending)"),
        unit_cost: cite(null),
      },
      // No SKU — dropped.
      { description: cite("Freight surcharge note"), unit_cost: cite(1.2) },
    ],
  },
];

// A quote sheet whose only lines are unusable — must throw, like a
// claimless refund report.
export const QUOTE_SHEET_RESPONSE_EMPTY = [
  {
    supplier_name: cite("Hangzhou Comfort Components"),
    quote_date: cite("2026-07-10"),
    line_items: [
      { sku: cite("EB-RCK-STL"), unit_cost: cite(null) },
      { description: cite("Tooling only"), unit_cost: cite(300) },
    ],
  },
];

export const REFUND_REPORT_RESPONSE = [
  {
    report_date: cite("2026-07-15"),
    claims: [
      {
        entry_summary_number: cite("231-4501287-4"),
        claim_type: cite("IEEPA REFUND"),
        claim_status: cite("CAPE ACCEPTED"),
        refund_status: cite("TRANSMITTED TO TREASURY"),
        refund_number: cite("R-88102"),
        refund_class_amount: cite("$4,812.50"),
        refund_interest_amount: cite(288.75),
        entry_date: cite("2026-01-12"),
        liquidation_date: cite("2026-06-20"),
        refund_date: cite("2026-07-10"),
      },
      {
        entry_summary_number: cite("231-4501293-1"),
        claim_type: cite("SECTION 301 REFUND"),
        claim_status: cite("REJECTED"),
        refund_status: cite(null),
        refund_number: cite(null),
        refund_class_amount: cite(0),
        refund_interest_amount: cite(null),
        entry_date: cite("2026-02-03"),
        liquidation_date: cite(null),
        refund_date: cite(null),
      },
    ],
  },
];

// Classification runs without citations — plain values.
export const CLASSIFY_RESPONSE = [{ doc_type: "port_entry" }];
export const CLASSIFY_RESPONSE_INVALID = [{ doc_type: "tax form" }];

// A port_entry response missing the required identifier.
export const PORT_ENTRY_RESPONSE_NO_NUMBER = [
  {
    entry_number: cite(null),
    line_items: [],
  },
];

import { describe, expect, it } from "vitest";

import { ORG_SEED, PART_SEED } from "@/lib/db/seed-data/story";
import { buildSeedReferenceData, type DayFn } from "@/lib/db/seed-data/tariff";

import { StubDocumentProcessor, type StubContext } from "./stub-processor";
import type { ProcessInput } from "./types";

// The stub fabricates against a snapshot of org data (loadStubContext in
// the app); tests prime it straight from the seed modules — the same story
// the demo db is seeded with.
const day: DayFn = (offset) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const ctx: StubContext = {
  importerOfRecord: ORG_SEED.importerOfRecord,
  parts: PART_SEED,
  bolPool: ["MAEU2264101", "ONEY8811327", "EGLV1420067"],
  poPool: ["PO-2026-001", "PO-2026-002", "PO-2026-003"],
  entryPool: ["231-4501287-4", "231-4501293-1"],
  reference: buildSeedReferenceData(day),
};

const processor = new StubDocumentProcessor(ctx);

// The stub always returns raw: null; these tests assert on the extraction.
async function extract(i: ProcessInput) {
  const { extraction, raw } = await processor.process(i);
  expect(raw).toBeNull();
  return extraction;
}

// Mirror of the stub's private hash, used to pick filenames that avoid (or
// hit) the deterministic first-attempt failure injection (seed % 8 === 0).
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function input(
  fileName: string,
  docTypeHint: ProcessInput["docTypeHint"],
  overrides: Partial<ProcessInput> = {},
): ProcessInput {
  return {
    storageKey: `test/${fileName}`,
    fileName,
    mimeType: "application/pdf",
    docTypeHint,
    attempt: 2, // skip the first-attempt failure injection
    ...overrides,
  };
}

describe("port_entry extraction", () => {
  it("is deterministic for the same filename", async () => {
    const a = await extract(input("entry-231-4501320-0.pdf", "port_entry"));
    const b = await extract(input("entry-231-4501320-0.pdf", "port_entry"));
    expect(a).toEqual(b);
  });

  it("builds catalog-backed line items whose sums match the header totals", async () => {
    const result = await extract(
      input("entry-231-4501320-0.pdf", "port_entry"),
    );
    if (result.docType !== "port_entry") throw new Error("wrong docType");
    const f = result.fields;

    expect(f.entry_number).toBe("231-4501320-0");
    // Org identity comes from the context snapshot, never a literal.
    expect(f.importer_of_record).toBe(ORG_SEED.importerOfRecord);
    expect(f.line_items.length).toBeGreaterThanOrEqual(3);
    expect(f.line_items.length).toBeLessThanOrEqual(5);

    let entered = 0;
    let duty = 0;
    let mpf = 0;
    let hmf = 0;
    for (const li of f.line_items) {
      expect(li.sku).toMatch(/^EB-/);
      expect(li.entered_value).toBeGreaterThan(0);
      expect(li.charges.length).toBeGreaterThan(0);
      entered += Math.round(li.entered_value * 100);
      for (const c of li.charges) {
        const cents = Math.round(c.amount * 100);
        if (
          c.charge_type === "base_duty" ||
          c.charge_type === "additional_duty" ||
          c.charge_type === "antidumping" ||
          c.charge_type === "countervailing"
        )
          duty += cents;
        if (c.charge_type === "mpf") mpf += cents;
        if (c.charge_type === "hmf") hmf += cents;
      }
    }
    expect(Math.round((f.total_entered_value ?? 0) * 100)).toBe(entered);
    expect(Math.round((f.total_duty ?? 0) * 100)).toBe(duty);
    expect(Math.round((f.mpf_amount ?? 0) * 100)).toBe(mpf);
    expect(Math.round((f.hmf_amount ?? 0) * 100)).toBe(hmf);
  });

  it("reaches the discrepancy classes across filenames", async () => {
    // (seed + lineIndex) % 6 assigns classes. A 5-line entry needs
    // seed % 3 === 2, which forces seed % 6 into {2, 5} — either window
    // covers both class 2 (the TW frame) and class 5 (the COO plant).
    let fileName = "";
    for (let i = 0; i < 50; i++) {
      const candidate = `entry-scan-${i}.pdf`;
      const seed = hashString(candidate);
      if (seed % 3 === 2 && seed % 8 !== 0) {
        fileName = candidate;
        break;
      }
    }
    expect(fileName).not.toBe("");

    const result = await extract(input(fileName, "port_entry"));
    if (result.docType !== "port_entry") throw new Error("wrong docType");
    expect(result.fields.line_items).toHaveLength(5);

    const seed = hashString(fileName);
    const classes = result.fields.line_items.map((_, i) => (seed + i) % 6);
    expect(classes).toContain(2);
    expect(classes).toContain(5);

    // Class 2 line is a TW frame that wrongly declares the reciprocal code.
    const frameLine = result.fields.line_items[classes.indexOf(2)];
    expect(frameLine.hts_code).toBe("8714.91.3000");
    expect(
      frameLine.charges.some((c) => c.hts_code === "9903.01.25"),
    ).toBe(true);

    // Class 5 line is the dual-sourced controller declared under its SECOND
    // vendor's name but with the primary source's origin — only the
    // COO-vs-catalog audit rule should fire on it.
    const cooLine = result.fields.line_items[classes.indexOf(5)];
    expect(cooLine.sku).toBe("EB-CTRL-V2");
    expect(cooLine.supplier_name).toBe("Hanoi Precision Components");
    expect(cooLine.country_of_origin).toBe("CN");
  });

  it("names the per-line supplier from the part's primary source", async () => {
    const result = await extract(
      input("entry-231-4501320-0.pdf", "port_entry"),
    );
    if (result.docType !== "port_entry") throw new Error("wrong docType");
    for (const li of result.fields.line_items) {
      expect(li.supplier_name).toBeTruthy();
      expect(li.country_of_origin).toMatch(/^[A-Z]{2}$/);
    }
  });

  it("fails on the first attempt for unlucky filenames, then succeeds", async () => {
    let fileName = "";
    for (let i = 0; i < 100; i++) {
      const candidate = `entry-batch-${i}.pdf`;
      if (hashString(candidate) % 8 === 0) {
        fileName = candidate;
        break;
      }
    }
    expect(fileName).not.toBe("");

    await expect(
      processor.process({ ...input(fileName, "port_entry"), attempt: 1 }),
    ).rejects.toThrow(/table structure/);
    await expect(
      processor.process({ ...input(fileName, "port_entry"), attempt: 2 }),
    ).resolves.toBeTruthy();
  });
});

describe("refund_report extraction", () => {
  it("prefers an entry number embedded in the filename", async () => {
    const result = await extract(
      input("refund-report-es022-231-4501287-4.pdf", "refund_report"),
    );
    if (result.docType !== "refund_report") throw new Error("wrong docType");
    expect(result.fields.claims.length).toBeGreaterThanOrEqual(1);
    expect(result.fields.claims[0].entry_summary_number).toBe("231-4501287-4");
    for (const claim of result.fields.claims) {
      expect(claim.claim_type).toBeTruthy();
      expect(claim.refund_class_amount).toBeGreaterThanOrEqual(0);
    }
  });

  it("claim keys (entry, type) are unique within one report", async () => {
    const result = await extract(
      input("refund-report-es022-july.pdf", "refund_report"),
    );
    if (result.docType !== "refund_report") throw new Error("wrong docType");
    const keys = result.fields.claims.map(
      (c) => `${c.entry_summary_number}:${c.claim_type}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("purchase_order extraction", () => {
  it("emits numbered lines with descriptions for the PO-line persistence", async () => {
    const result = await extract(input("po-2026-004.pdf", "purchase_order"));
    if (result.docType !== "purchase_order") throw new Error("wrong docType");
    expect(result.fields.po_number).toBe("PO-2026-004");
    expect(result.fields.line_items).toHaveLength(2);
    expect(result.fields.line_items.map((li) => li.line_number)).toEqual([1, 2]);
    for (const li of result.fields.line_items) {
      expect(li.sku).toMatch(/^EB-/);
      expect(li.description).toBeTruthy();
      expect(li.unit_price).toBeGreaterThan(0);
    }
  });
});

describe("quote_sheet extraction", () => {
  it("quotes one known catalog SKU and one unknown SKU (draft-creation path)", async () => {
    const result = await extract(
      input("saddle-supplier-quote-q3.pdf", "quote_sheet"),
    );
    if (result.docType !== "quote_sheet") throw new Error("wrong docType");
    const f = result.fields;

    expect(f.supplier_name).toBeTruthy();
    expect(f.quote_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Validity extends into the future relative to the quote date.
    expect(f.valid_until && f.quote_date && f.valid_until > f.quote_date).toBe(
      true,
    );
    expect(f.line_items).toHaveLength(2);

    const [known, unknown] = f.line_items;
    // Known line: a catalog part re-quoted by its own primary vendor at or
    // below the current cost — the re-quote path.
    const catalog = new Map(
      PART_SEED.filter((p) => p.htsCode !== null && p.status === "active").map(
        (p) => [p.sku, p],
      ),
    );
    const part = catalog.get(known.sku);
    expect(part).toBeDefined();
    expect(known.unit_cost).toBeGreaterThan(0);
    expect(known.unit_cost).toBeLessThanOrEqual(
      Number(part!.sources[0].unitCost),
    );
    expect(f.supplier_name).toBe(part!.sources[0].vendor);
    // Supplier's claimed HTS rides along but never drives money.
    expect(known.hts_code).toBe(part!.htsCode);
    // Unknown SKU — ingestion auto-creates a draft part for it.
    expect(unknown.sku).toBe("EB-RCK-ALU");
    expect(catalog.has(unknown.sku)).toBe(false);
    expect(unknown.unit_cost).toBeGreaterThan(0);
    expect(unknown.line_number).toBe(2);
  });

  it("is deterministic for the same filename", async () => {
    const a = await extract(input("pricing-2026-q3.pdf", "quote_sheet"));
    const b = await extract(input("pricing-2026-q3.pdf", "quote_sheet"));
    expect(a).toEqual(b);
  });
});

describe("entry_packet extraction", () => {
  it("returns a stable manifest whose assist sheet routes to other", async () => {
    const a = await extract(input("test-entry-packet-1.pdf", "entry_packet"));
    const b = await extract(input("test-entry-packet-1.pdf", "entry_packet"));
    expect(a).toEqual(b);
    if (a.docType !== "entry_packet") throw new Error("wrong docType");
    expect(a.fields.parts.map((p) => [p.role, p.doc_type])).toEqual([
      ["entry_summary_7501", "port_entry"],
      ["commercial_invoice", "commercial_invoice"],
      ["packing_list", "packing_list"],
      // The look-alike lesson: an assist sheet is never an invoice.
      ["assist_sheet", "other"],
    ]);
    // Pages tile the 6-page fixture without overlap.
    expect(a.fields.parts.flatMap((p) => p.pages)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("keeps sibling children consistent via the shared storageKey", async () => {
    // Children of one packet share the parent's storageKey and differ only
    // in fileName/role — the invoice pair must agree in either order.
    const storageKey = "packets/2026/08/abc123.pdf";
    const entryChild = await extract(
      input("packet — Entry summary (pp. 1–2).pdf", "port_entry", {
        storageKey,
        packetRole: "entry_summary_7501",
        pageRange: [1, 2],
      }),
    );
    const invoiceChild = await extract(
      input("packet — Commercial invoice (pp. 3–4).pdf", "commercial_invoice", {
        storageKey,
        packetRole: "commercial_invoice",
        pageRange: [3, 4],
      }),
    );
    if (entryChild.docType !== "port_entry") throw new Error("wrong docType");
    if (invoiceChild.docType !== "commercial_invoice")
      throw new Error("wrong docType");

    expect(entryChild.fields.referenced_invoices).toHaveLength(1);
    expect(entryChild.fields.referenced_invoices[0]).toBe(
      invoiceChild.fields.invoice_number,
    );
    expect(invoiceChild.fields.po_number).toBe(
      entryChild.fields.referenced_pos[0],
    );
    // Packet CI lines carry the catalog HTS for the CI-vs-entry check.
    for (const li of invoiceChild.fields.line_items) {
      expect(li.hts_code).toBeTruthy();
    }
  });

  it("standalone port entries reference no invoices", async () => {
    const result = await extract(
      input("entry-231-4501320-0.pdf", "port_entry"),
    );
    if (result.docType !== "port_entry") throw new Error("wrong docType");
    expect(result.fields.referenced_invoices).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";

import { StubDocumentProcessor } from "./stub-processor";
import type { ProcessInput } from "./types";

const processor = new StubDocumentProcessor();

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

function input(fileName: string, docTypeHint: ProcessInput["docTypeHint"]): ProcessInput {
  return {
    storageKey: `test/${fileName}`,
    fileName,
    mimeType: "application/pdf",
    docTypeHint,
    attempt: 2, // skip the first-attempt failure injection
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

  it("reaches every discrepancy class across filenames", async () => {
    // (seed + lineIndex) % 5 assigns classes; a 5-line entry (seed % 3 === 2)
    // covers all five. Find one such filename deterministically.
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
    const classes = result.fields.line_items.map((_, i) => (seed + i) % 5);
    expect([...classes].sort()).toEqual([0, 1, 2, 3, 4]);

    // Class 2 line is a TW frame that wrongly declares the reciprocal code.
    const frameLine = result.fields.line_items[classes.indexOf(2)];
    expect(frameLine.hts_code).toBe("8714.91.3000");
    expect(
      frameLine.charges.some((c) => c.hts_code === "9903.01.25"),
    ).toBe(true);
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
    // Known catalog SKU (seeded) — the re-quote path.
    expect(known.sku).toBe("EB-SDL-CMF");
    expect(known.unit_cost).toBeGreaterThan(0);
    expect(known.unit_cost).toBeLessThanOrEqual(9.8);
    // Supplier's claimed HTS rides along but never drives money.
    expect(known.hts_code).toBe("8714.95.0000");
    // Unknown SKU — ingestion auto-creates a draft part for it.
    expect(unknown.sku).toBe("EB-RCK-ALU");
    expect(unknown.unit_cost).toBeGreaterThan(0);
    expect(unknown.line_number).toBe(2);
  });

  it("is deterministic for the same filename", async () => {
    const a = await extract(input("pricing-2026-q3.pdf", "quote_sheet"));
    const b = await extract(input("pricing-2026-q3.pdf", "quote_sheet"));
    expect(a).toEqual(b);
  });
});

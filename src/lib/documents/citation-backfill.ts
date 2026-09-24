import type { CitedEntityType } from "./citations";
import type {
  CommercialInvoiceExtraction,
  ExtractionCitations,
  FieldCitations,
  PortEntryExtraction,
  SourceBox,
} from "@/lib/processing/types";

// Provenance for rows that were written before citations were persisted
// (scripts/backfill-citations.ts): the stored cited payload is re-mapped
// with today's mapper, and each citation is planned onto the existing row
// whose facts it backs. Pure. A citation is planned only where the stored
// value still equals the re-mapped one — the extraction that produced a row
// may have been post-processed since (a scrubbed SKU, a blanked quantity,
// Block 43 fees) or mapped by an older mapper, and a citation must never
// point at a cell the persisted value did not come from.

export type PlannedCitation = {
  entityType: CitedEntityType;
  entityId: string;
  field: string;
  page: number;
  boxes: SourceBox[];
  printed: string | null;
};

export type StoredEntry = {
  id: string;
  entryNumber: string;
  entryDate: string | null;
  portOfEntry: string | null;
  entryType: string | null;
  importerOfRecord: string | null;
  totalEnteredValue: string | null;
  totalDuty: string | null;
  mpfAmount: string | null;
  hmfAmount: string | null;
  lines: StoredEntryLine[];
};

export type StoredEntryLine = {
  id: string;
  lineNumber: number;
  sku: string | null;
  description: string | null;
  htsCode: string;
  spi: string | null;
  countryOfOrigin: string | null;
  supplierName: string | null;
  quantity: string | null;
  quantityUnit: string | null;
  unitValue: string | null;
  enteredValue: string;
  /** In insertion order. */
  charges: StoredCharge[];
};

export type StoredCharge = {
  id: string;
  chargeType: string;
  htsCode: string | null;
  rate: string | null;
  amount: string;
};

export type StoredInvoice = {
  id: string;
  invoiceNumber: string;
  supplierName: string | null;
  invoiceDate: string | null;
  currency: string;
  totalAmount: string | null;
  subtotal: string | null;
  incoterms: string | null;
  lines: StoredInvoiceLine[];
};

export type StoredInvoiceLine = {
  id: string;
  lineNumber: number;
  sku: string | null;
  description: string | null;
  countryOfOrigin: string | null;
  htsCode: string | null;
  quantity: string | null;
  quantityUnit: string | null;
  unitPrice: string | null;
  totalPrice: string;
};

export type BackfillPlan = {
  rows: PlannedCitation[];
  /** Why a cited fact was not planned — for the dry run's report. */
  skipped: string[];
};

const digits = (code: string | null | undefined) =>
  (code ?? "").replace(/\D/g, "");

/** Stored numerics are strings ("10500.00"); mapped values are numbers.
 *  Equal when they agree to the cent (or the ten-thousandth for
 *  quantities and unit values). */
function sameValue(stored: unknown, mapped: unknown, field: string): boolean {
  if (stored === null || stored === undefined) return false;
  if (mapped === null || mapped === undefined) return false;
  if (typeof mapped === "number") {
    const n = Number(stored);
    if (!Number.isFinite(n)) return false;
    const places = /quantity|unit_value|unit_price|rate/.test(field) ? 1e6 : 100;
    return Math.round(n * places) === Math.round(mapped * places);
  }
  if (field.endsWith("hts_code")) {
    return digits(String(stored)) === digits(String(mapped));
  }
  return String(stored).trim().toUpperCase() === String(mapped).trim().toUpperCase();
}

/** Citations for the fields whose stored value equals the mapped one. */
function agreeing(
  entityType: CitedEntityType,
  entityId: string,
  citations: FieldCitations | undefined,
  stored: Record<string, unknown>,
  mapped: Record<string, unknown>,
  where: string,
  skipped: string[],
): PlannedCitation[] {
  if (!citations) return [];
  const out: PlannedCitation[] = [];
  for (const [field, citation] of Object.entries(citations)) {
    if (!(field in stored)) {
      // A document-only fact (bond type, MID): nothing stored to check
      // against, and nothing to contradict — keep it.
      out.push(planned(entityType, entityId, field, citation));
      continue;
    }
    if (!sameValue(stored[field], mapped[field], field)) {
      skipped.push(`${where}.${field}: stored ${String(stored[field])} ≠ mapped ${String(mapped[field])}`);
      continue;
    }
    out.push(planned(entityType, entityId, field, citation));
  }
  return out;
}

function planned(
  entityType: CitedEntityType,
  entityId: string,
  field: string,
  citation: FieldCitations[string],
): PlannedCitation {
  return {
    entityType,
    entityId,
    field,
    page: citation.boxes[0].page,
    boxes: citation.boxes,
    printed: citation.printed,
  };
}

export function planEntryCitations(
  extraction: PortEntryExtraction,
  citations: ExtractionCitations,
  stored: StoredEntry,
): BackfillPlan {
  const skipped: string[] = [];
  const rows: PlannedCitation[] = [];

  rows.push(
    ...agreeing(
      "entry",
      stored.id,
      citations.header,
      {
        entry_number: stored.entryNumber,
        entry_date: stored.entryDate,
        port_of_entry: stored.portOfEntry,
        entry_type: stored.entryType,
        importer_of_record: stored.importerOfRecord,
        total_entered_value: stored.totalEnteredValue,
        total_duty: stored.totalDuty,
        mpf_amount: stored.mpfAmount,
        hmf_amount: stored.hmfAmount,
      },
      extraction as unknown as Record<string, unknown>,
      `entry ${stored.entryNumber}`,
      skipped,
    ),
  );

  const byNumber = new Map(stored.lines.map((l) => [l.lineNumber, l]));
  extraction.line_items.forEach((mapped, i) => {
    const line = byNumber.get(mapped.line_number);
    const cited = citations.lines[i];
    if (!line || !cited) {
      skipped.push(`line ${mapped.line_number}: no stored line`);
      return;
    }
    if (
      digits(line.htsCode) !== digits(mapped.hts_code) ||
      !sameValue(line.enteredValue, mapped.entered_value, "entered_value")
    ) {
      skipped.push(
        `line ${mapped.line_number}: stored ${line.htsCode} @ ${line.enteredValue} ≠ mapped ${mapped.hts_code} @ ${mapped.entered_value}`,
      );
      return;
    }
    rows.push(
      ...agreeing(
        "entry_line_item",
        line.id,
        cited.fields,
        {
          line_number: line.lineNumber,
          sku: line.sku,
          description: line.description,
          hts_code: line.htsCode,
          spi: line.spi,
          country_of_origin: line.countryOfOrigin,
          supplier_name: line.supplierName,
          quantity: line.quantity,
          quantity_unit: line.quantityUnit,
          unit_value: line.unitValue,
          entered_value: line.enteredValue,
        },
        mapped as unknown as Record<string, unknown>,
        `line ${mapped.line_number}`,
        skipped,
      ),
    );
    // Charges pair by position when the stack is the same length and every
    // position agrees on type, code and amount; otherwise nothing is
    // planned for the line's charges.
    if (line.charges.length !== mapped.charges.length) {
      skipped.push(
        `line ${mapped.line_number} charges: stored ${line.charges.length} ≠ mapped ${mapped.charges.length}`,
      );
      return;
    }
    const aligned = mapped.charges.every(
      (c, j) =>
        line.charges[j].chargeType === c.charge_type &&
        digits(line.charges[j].htsCode) === digits(c.hts_code) &&
        sameValue(line.charges[j].amount, c.amount, "amount"),
    );
    if (!aligned) {
      skipped.push(`line ${mapped.line_number} charges: stack differs`);
      return;
    }
    mapped.charges.forEach((c, j) => {
      const charge = line.charges[j];
      rows.push(
        ...agreeing(
          "entry_line_charge",
          charge.id,
          cited.charges[j],
          {
            charge_type: charge.chargeType,
            hts_code: charge.htsCode,
            rate: charge.rate,
            amount: charge.amount,
          },
          c as unknown as Record<string, unknown>,
          `line ${mapped.line_number} charge ${j + 1}`,
          skipped,
        ),
      );
    });
  });
  return { rows, skipped };
}

export function planInvoiceCitations(
  extraction: CommercialInvoiceExtraction,
  citations: ExtractionCitations,
  stored: StoredInvoice,
): BackfillPlan {
  const skipped: string[] = [];
  const rows: PlannedCitation[] = [];
  rows.push(
    ...agreeing(
      "invoice",
      stored.id,
      citations.header,
      {
        invoice_number: stored.invoiceNumber,
        supplier_name: stored.supplierName,
        invoice_date: stored.invoiceDate,
        currency: stored.currency,
        amount: stored.totalAmount,
        subtotal: stored.subtotal,
        incoterms: stored.incoterms,
      },
      extraction as unknown as Record<string, unknown>,
      `invoice ${stored.invoiceNumber}`,
      skipped,
    ),
  );
  const byNumber = new Map(stored.lines.map((l) => [l.lineNumber, l]));
  extraction.line_items.forEach((mapped, i) => {
    const line = byNumber.get(mapped.line_number);
    const cited = citations.lines[i];
    if (!line || !cited) {
      skipped.push(`invoice line ${mapped.line_number}: no stored line`);
      return;
    }
    if (!sameValue(line.totalPrice, mapped.total_price, "total_price")) {
      skipped.push(
        `invoice line ${mapped.line_number}: stored total ${line.totalPrice} ≠ mapped ${mapped.total_price}`,
      );
      return;
    }
    rows.push(
      ...agreeing(
        "invoice_line_item",
        line.id,
        cited.fields,
        {
          line_number: line.lineNumber,
          sku: line.sku,
          description: line.description,
          country_of_origin: line.countryOfOrigin,
          hts_code: line.htsCode,
          quantity: line.quantity,
          quantity_unit: line.quantityUnit,
          unit_price: line.unitPrice,
          total_price: line.totalPrice,
        },
        mapped as unknown as Record<string, unknown>,
        `invoice line ${mapped.line_number}`,
        skipped,
      ),
    );
  });
  return { rows, skipped };
}

// Shared shapes for the entry analyst. The bundle is everything the analyst
// may reach during one entry's investigation, loaded up front so the tools
// themselves do zero IO; the analyst interface is env-selected (index.ts)
// exactly like the measure extractor.
//
// Relative imports on purpose — this module runs under the tsx eval script.

import type { AuditableSnapshot } from "../audit/auditor";
import type { ReferenceData } from "../duty/types";
import type { SuppressionSpec } from "../org-rules";
import type { FindingsReport } from "./findings";

/** An enabled org rule, as the analyst sees it: the standing-instruction
 *  text plus the suppression spec (when present) so the prompt and the
 *  deterministic-findings tool can attribute suppressed alerts. */
export type BundleOrgRule = {
  id: string;
  text: string;
  suppression: SuppressionSpec | null;
};

export type BundleDocument = {
  id: string;
  fileName: string;
  docType: string;
  status: string;
  /** Packet-child role and 1-indexed page range; null for standalone docs. */
  packetRole: string | null;
  pageRange: number[] | null;
  /** Every provenance link that pulled this document into the entry's orbit
   *  (entry itself, a linked shipment/PO/invoice). */
  linkedVia: { entityType: string; entityId: string }[];
  /** Typed extraction fields. rawExtraction is never loaded (multi-MB). */
  extractedData: unknown;
};

export type BundlePart = {
  sku: string;
  name: string;
  description: string | null;
  status: string;
  /** Current-window catalog code; provisional codes are classifier guesses
   *  a human has not committed. */
  htsCode: string | null;
  htsCodeProvisional: boolean;
  sources: {
    vendorName: string;
    countryOfOrigin: string | null;
    unitCost: string | null;
    validFrom: string | null;
    validTo: string | null;
  }[];
  classifications: {
    htsCode: string;
    validFrom: string | null;
    validTo: string | null;
  }[];
};

export type BundleAdcvdOrder = {
  caseNumber: string;
  country: string;
  merchandise: string;
  scopeSummary: string;
  htsPrefixes: string[];
  status: "active" | "revoked";
  effectiveDate: string | null;
  revokedDate: string | null;
  /** null producer = the all-others rate. Decimal fractions. */
  depositRates: { producer: string | null; rate: number }[];
  source: string | null;
};

export type BundleSiblingEntry = {
  entryNumber: string;
  entryDate: string | null;
  entryType: string | null;
  totalEnteredValue: string | null;
  totalDuty: string | null;
  /** The shipments this sibling shares with the entry under analysis. */
  sharedShipments: {
    shipmentNumber: string;
    billOfLading: string | null;
    mode: string;
  }[];
  lines: {
    lineNumber: number;
    sku: string | null;
    description: string | null;
    htsCode: string | null;
    /** Declared SPI preference claim — cross-entry consistency checks
     *  compare preference treatment the same way as Ch99 treatment. */
    spi: string | null;
    countryOfOrigin: string | null;
    supplierName: string | null;
    quantity: string | null;
    enteredValue: string | null;
    charges: {
      chargeType: string;
      htsCode: string | null;
      rate: string | null;
      amount: string | null;
    }[];
  }[];
};

export type EntryBundle = {
  orgId: string;
  snapshot: AuditableSnapshot;
  documents: BundleDocument[];
  /** Other entries on this entry's shipments, with their declared lines and
   *  charges — the cross-entry consistency corpus. Goods moving together
   *  should get identical Ch99 treatment; without this the analyst only sees
   *  siblings when a packet document happens to home onto both entries. */
  siblingEntries: BundleSiblingEntry[];
  /** Catalog data for every SKU on the entry's lines (missing SKUs simply
   *  have no entry — itself a signal the analyst can surface). */
  partsBySku: Map<string, BundlePart>;
  /** The full AD/CVD order corpus (global, small) — indicative context for
   *  case-number/rate adjudication, never deterministic duty math. */
  adcvdOrders: BundleAdcvdOrder[];
  /** Enabled org rules — standing instructions injected into the system
   *  prompt; suppression specs also annotate get_deterministic_findings. */
  orgRules: BundleOrgRule[];
};

/** One tool invocation, recorded for the eval transcript. */
export type ToolTraceEntry = {
  tool: string;
  input: unknown;
  resultPreview: string;
};

export type AnalystUsage = {
  iterations: number;
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
};

export type AnalystResult = {
  report: FindingsReport;
  usage: AnalystUsage;
  trace: ToolTraceEntry[];
  /** "claude" | "stub"; the stub also backstops a degraded Claude run. */
  analyst: "claude" | "stub";
  /** Set when the run degraded (refusal, deadline, parse failure) — the
   *  report may be partial or stub-derived. Never a thrown error. */
  error: string | null;
};

export interface EntryAnalyst {
  analyze(bundle: EntryBundle, ref: ReferenceData): Promise<AnalystResult>;
}

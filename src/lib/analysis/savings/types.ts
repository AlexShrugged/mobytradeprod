// Shared shapes for the part-scoped HTS-savings analyst. The bundle is
// everything the analyst may reach for one part, loaded up front so the
// tools do zero IO — the same contract as the entry analyst's bundle.
//
// Relative imports on purpose — this module runs under the tsx script.

import type { ReferenceData } from "../../duty/types";
import type { ToolTraceEntry, AnalystUsage } from "../types";
import type { SavingsReport } from "./report";

export type SavingsHistoryLine = {
  entryNumber: string;
  entryDate: string | null;
  lineNumber: number;
  htsCode: string;
  countryOfOrigin: string | null;
  quantity: string | null;
  enteredValue: string;
  /** Duty-class charges only (base/additional/AD/CVD), as declared. */
  dutyCharges: { chargeType: string; rate: string | null; amount: string }[];
};

export type PartBundle = {
  orgId: string;
  part: {
    id: string;
    sku: string;
    name: string;
    description: string | null;
    status: string;
    /** Current committed catalog code; null when none. */
    htsCode: string | null;
    htsCodeProvisional: boolean;
    classifications: {
      htsCode: string;
      validFrom: string | null;
      validTo: string | null;
    }[];
    sources: {
      vendorName: string;
      countryOfOrigin: string | null;
      unitCost: string | null;
      validFrom: string | null;
      validTo: string | null;
    }[];
  };
  /** The part's entry lines, newest first (trailing ~12 months). */
  history: SavingsHistoryLine[];
  /** Sum of history entered values in cents — the annualized duty basis
   *  compare_codes prices candidates against. */
  trailingEnteredValueCents: number;
  /** Distinct origins across sources + history, the default COO context. */
  countriesOfOrigin: string[];
};

export type SavingsResult = {
  report: SavingsReport;
  usage: AnalystUsage;
  trace: ToolTraceEntry[];
  analyst: "claude" | "stub";
  /** Set when the run degraded — the report may be empty. Never thrown. */
  error: string | null;
};

export interface SavingsAnalyst {
  analyze(bundle: PartBundle, ref: ReferenceData): Promise<SavingsResult>;
}

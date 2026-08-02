import type { DocumentTypeValue } from "@/lib/db/schema";

import { ReductoDocumentProcessor } from "./reducto";
import { StubDocumentProcessor } from "./stub-processor";
import type { DocumentProcessor } from "./types";

// With REDUCTO_API_KEY set, documents go through real Reducto extraction;
// without it, the deterministic stub. Everything downstream only sees the
// interface.
export function getProcessor(): DocumentProcessor {
  if (process.env.REDUCTO_API_KEY) return new ReductoDocumentProcessor();
  return new StubDocumentProcessor();
}

// Filename-based classification at upload time. Reducto classification
// overrides this hint at process time; it remains the fallback when
// classification is inconclusive, and the stub's only signal.
export function inferDocType(fileName: string): DocumentTypeValue {
  const name = fileName.toLowerCase();
  // Before the "entry" check: refund reports reference entry numbers too.
  if (
    name.includes("refund") ||
    name.includes("es-022") ||
    name.includes("es022")
  )
    return "refund_report";
  if (name.includes("entry")) return "port_entry";
  if (name.includes("bol") || name.includes("shipment") || name.includes("awb"))
    return "shipment";
  if (name.includes("invoice")) return "commercial_invoice";
  if (name.includes("packing")) return "packing_list";
  // "quot" covers quote/quotation; "pricing" covers supplier price sheets.
  if (name.includes("quot") || name.includes("pricing"))
    return "quote_sheet";
  if (/(^|[^a-z])po[-_]/.test(name) || name.includes("purchase"))
    return "purchase_order";
  return "other";
}

import type { DbClient } from "@/lib/db";
import type { DocumentTypeValue } from "@/lib/db/schema";
import { isProdRuntime } from "@/lib/env";

import { ReductoDocumentProcessor } from "./reducto";
import { loadStubContext, StubDocumentProcessor } from "./stub-processor";
import type { DocumentProcessor } from "./types";

// With REDUCTO_API_KEY set, documents go through real Reducto extraction;
// without it, the deterministic stub, primed with a snapshot of the org's
// current data so fabricated documents reference real records. Everything
// downstream only sees the interface. On Vercel the stub is refused — it
// fabricates document contents (with cross-org reads) and simulates
// failures, which must never masquerade as real extraction in production.
// The throw lands in processDocumentRow's catch, marking the doc failed
// with this message.
export async function getProcessor(db: DbClient): Promise<DocumentProcessor> {
  if (process.env.REDUCTO_API_KEY) return new ReductoDocumentProcessor();
  if (isProdRuntime()) {
    throw new Error(
      "REDUCTO_API_KEY is required on Vercel — refusing the stub document processor.",
    );
  }
  return new StubDocumentProcessor(await loadStubContext(db));
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
  // Before the "entry" check: packet filenames usually contain "entry" too
  // ("entry-packet-...", broker "ACH PACKET-...").
  if (name.includes("packet")) return "entry_packet";
  if (name.includes("entry")) return "port_entry";
  if (name.includes("bol") || name.includes("shipment") || name.includes("awb"))
    return "shipment";
  // Before the "invoice" check: a broker's own bill must not carry a
  // commercial_invoice hint into classification (mirrors assist sheets).
  if (name.includes("broker") && name.includes("invoice")) return "other";
  if (name.includes("invoice")) return "commercial_invoice";
  if (name.includes("packing")) return "packing_list";
  // "quot" covers quote/quotation; "pricing" covers supplier price sheets.
  if (name.includes("quot") || name.includes("pricing"))
    return "quote_sheet";
  if (/(^|[^a-z])po[-_]/.test(name) || name.includes("purchase"))
    return "purchase_order";
  return "other";
}

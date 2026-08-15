import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// The one status→tone lookup. Every status-ish string in the app renders
// through here so colors stay consistent across pages.
type Tone = "neutral" | "blue" | "green" | "amber" | "red" | "violet";

const toneClasses: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground border-transparent",
  blue: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20",
  green:
    "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
  amber:
    "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
  red: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20",
  violet:
    "bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/20",
};

const statusMeta: Record<string, { label: string; tone: Tone }> = {
  // entries — DERIVED states (entries/status.ts): filed by construction
  // (an entry row only exists because a 7501 was processed), liquidated
  // from refund-claim liquidation dates. "released" does not exist: no
  // ingested document evidences CBP release. (draft is shared with parts.)
  draft: { label: "Draft", tone: "neutral" },
  filed: { label: "Filed", tone: "blue" },
  liquidated: { label: "Liquidated", tone: "violet" },
  // future entries (derived projection)
  projected: { label: "Projected", tone: "amber" },
  // shipments
  // Shipment lifecycle — DERIVED states (shipments/status.ts); "delivered"
  // does not exist: nothing we ingest can prove delivery.
  booked: { label: "Booked", tone: "neutral" },
  in_transit: { label: "In transit", tone: "blue" },
  arrived: { label: "Arrived", tone: "green" },
  // POs carry no status (receipt is a warehouse event nothing we ingest
  // evidences); "open"/"received"/"closed" remain for other domains.
  open: { label: "Open", tone: "blue" },
  received: { label: "Received", tone: "green" },
  closed: { label: "Closed", tone: "neutral" },
  // documents
  pending: { label: "Pending", tone: "neutral" },
  processing: { label: "Processing", tone: "blue" },
  processed: { label: "Processed", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  // parts (draft shared with entries above)
  active: { label: "Active", tone: "green" },
  archived: { label: "Archived", tone: "neutral" },
  pending_changes: { label: "Pending changes", tone: "amber" },
  // quotes ("received"/"rejected" reuse rows above where labels differ)
  quote_received: { label: "Received", tone: "blue" },
  approved: { label: "Approved", tone: "amber" },
  applied: { label: "Applied", tone: "green" },
  rejected: { label: "Rejected", tone: "red" },
  superseded: { label: "Superseded", tone: "neutral" },
  // refunds (derived stage)
  paid: { label: "Paid", tone: "green" },
  pending_payout: { label: "Pending payout", tone: "amber" },
  // review
  confirmed: { label: "Confirmed", tone: "green" },
  accepted: { label: "Accepted", tone: "green" },
  acknowledged: { label: "Acknowledged", tone: "green" },
  // integrations
  paused: { label: "Paused", tone: "neutral" },
  error: { label: "Error", tone: "red" },
  not_configured: { label: "Not configured", tone: "neutral" },
  // variances (audit alert types) + entry-line state pills
  hts_discrepancy: { label: "HTS mismatch", tone: "amber" },
  hts_reclassified: { label: "Reclassified", tone: "violet" },
  coo_discrepancy: { label: "Origin mismatch", tone: "amber" },
  rate_mismatch: { label: "Rate mismatch", tone: "red" },
  amount_mismatch: { label: "Duty mismatch", tone: "red" },
  missing_measure: { label: "Missing measure", tone: "red" },
  unexpected_measure: { label: "Unexpected measure", tone: "violet" },
  value_mismatch: { label: "Value mismatch", tone: "blue" },
  data_unreconciled: { label: "Unreconciled", tone: "neutral" },
  sail_date_assumption: { label: "Sail assumed", tone: "blue" },
  // CI-vs-entry document comparisons
  quantity_discrepancy: { label: "Quantity mismatch", tone: "amber" },
  invoice_hts_mismatch: { label: "CI HTS mismatch", tone: "amber" },
  invoice_sku_missing: { label: "Not on invoice", tone: "blue" },
  invoice_comparison_skipped: { label: "CI skipped", tone: "neutral" },
  needs_review: { label: "Needs review", tone: "amber" },
  // AI analyst findings ("ai_" + finding category). The AI prefix carries
  // the evidence source, same as the CI prefix above; the rest names what
  // disagrees.
  ai_adcvd_discrepancy: { label: "AI AD/CVD", tone: "red" },
  ai_fee_error: { label: "AI fee error", tone: "red" },
  ai_coo_inconsistency: { label: "AI origin", tone: "amber" },
  ai_classification_mismatch: { label: "AI HTS", tone: "amber" },
  ai_valuation_concern: { label: "AI valuation", tone: "blue" },
  ai_document_inconsistency: { label: "AI documents", tone: "amber" },
  ai_duty_calculation: { label: "AI duty", tone: "red" },
  ai_other: { label: "AI finding", tone: "violet" },
};

export function StatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const meta = statusMeta[status] ?? { label: status, tone: "neutral" as Tone };
  return (
    <Badge
      variant="outline"
      className={cn("font-normal", toneClasses[meta.tone], className)}
    >
      {meta.label}
    </Badge>
  );
}

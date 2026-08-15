import { PageHeader } from "@/components/page-header";
import { StatTile } from "@/components/stat-tile";
import { VarianceView } from "@/components/variance/variance-view";
import { getVarianceQueue, type VarianceQueueRow } from "@/lib/db/queries/variance";
import { formatCents } from "@/lib/format";
import { dedupedImpactSums, partitionVarianceRows } from "@/lib/variance/grouping";

export const dynamic = "force-dynamic";

// ONE AXIS: what disagrees. Never group by what we compared against — the
// commercial invoice is the primary counterparty for variance, so a "source"
// option would swallow most of the queue and filter nothing. (It also split
// evidence incoherently: coo_discrepancy serves both catalog and CI evidence,
// so CI-sourced origin landed under Origin while CI-sourced HTS landed under
// Invoice.) Evidence source is carried by the row badge instead —
// status-badge.tsx renders "CI HTS mismatch" vs "HTS mismatch". If source
// ever needs to be filterable, it belongs as a second dimension, not a peer
// option.
//
// Every member of audit_alert_type must appear in exactly one bucket, and
// every AI finding category (as "ai_" + category) likewise — AI-ness is an
// evidence source carried by the row badge, so AI rows file under what
// disagrees, joining the rule bucket for the same axis where one exists.
const TYPE_FILTERS: Record<string, { label: string; types: string[] }> = {
  hts: {
    label: "Classification",
    types: [
      "hts_discrepancy",
      "invoice_hts_mismatch",
      "ai_classification_mismatch",
    ],
  },
  // Not a variance — the filing was right on its day. A refund lead.
  reclassified: { label: "Reclassified", types: ["hts_reclassified"] },
  origin: { label: "Origin", types: ["coo_discrepancy", "ai_coo_inconsistency"] },
  value: { label: "Value", types: ["value_mismatch", "ai_valuation_concern"] },
  quantity: { label: "Quantity", types: ["quantity_discrepancy"] },
  duty: {
    label: "Duty",
    types: [
      "rate_mismatch",
      "amount_mismatch",
      "missing_measure",
      "unexpected_measure",
      "ai_duty_calculation",
    ],
  },
  // Axes only the analyst covers (the deterministic rules deliberately
  // skip fees, and no rule reads AD/CVD case numbers or cross-document
  // narratives).
  adcvd: { label: "AD/CVD", types: ["ai_adcvd_discrepancy"] },
  fees: { label: "Fees", types: ["ai_fee_error"] },
  documents: {
    label: "Documents",
    types: ["ai_document_inconsistency", "ai_other"],
  },
  // Nothing disagrees — we couldn't compare, or can't trust what we compared.
  data: {
    label: "Data quality",
    types: [
      "data_unreconciled",
      "sail_date_assumption",
      "invoice_sku_missing",
      "invoice_comparison_skipped",
    ],
  },
};

export default async function VariancePage() {
  const rows = await getVarianceQueue();

  // The queue carries every status; the tiles report only what's open —
  // decided rows exist solely for the table's Resolved view.
  const openRows = rows.filter((r) => r.status === "open");

  // Headline dollars stay issue-level (deduped); the table consolidates to
  // one row per line item.
  const { recoverable, exposure } = dedupedImpactSums(openRows);
  const { active, archived } = partitionVarianceRows(rows);
  const nearest = openRows
    .filter((r) => !r.window.closed && r.window.daysLeft !== null)
    .reduce<VarianceQueueRow | null>(
      (best, r) =>
        best === null || r.window.daysLeft! < best.window.daysLeft!
          ? r
          : best,
      null,
    );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Variance"
        info="Filed entries that disagree with your commercial invoices, your catalog, or official tariff data, ranked by dollar impact. Click a line to reconcile it against source documents."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Open variances"
          value={String(openRows.length)}
          tone={openRows.length > 0 ? "amber" : "default"}
        />
        <StatTile
          label="Recoverable"
          value={recoverable > 0 ? `+${formatCents(recoverable)}` : "—"}
          tone={recoverable > 0 ? "green" : "default"}
        />
        <StatTile
          label="Exposure"
          value={exposure > 0 ? `−${formatCents(exposure)}` : "—"}
          tone={exposure > 0 ? "red" : "default"}
        />
        <StatTile
          label="Nearest window"
          value={
            nearest?.window.daysLeft != null
              ? `${nearest.window.daysLeft}d`
              : "—"
          }
        />
      </div>

      <VarianceView
        openGroups={active}
        resolvedGroups={archived}
        typeFilters={TYPE_FILTERS}
      />
    </div>
  );
}

import { PageHeader } from "@/components/page-header";
import { StatTile } from "@/components/stat-tile";
import { VarianceView } from "@/components/variance/variance-view";
import { getVarianceQueue, type VarianceQueueRow } from "@/lib/db/queries/variance";
import { formatCents, formatDate } from "@/lib/format";
import { dedupedImpactSums, partitionVarianceRows } from "@/lib/variance/grouping";

export const dynamic = "force-dynamic";

// ONE AXIS: what disagrees. Never group by what we compared against — the
// commercial invoice is the primary counterparty for variance, so a "source"
// chip would swallow most of the queue and filter nothing. (It also split
// evidence incoherently: coo_discrepancy serves both catalog and CI evidence,
// so CI-sourced origin landed under Origin while CI-sourced HTS landed under
// Invoice.) Evidence source is carried by the row badge instead —
// status-badge.tsx renders "CI HTS mismatch" vs "HTS mismatch". If source ever
// needs to be filterable, it belongs as a second dimension, not a peer chip.
//
// Every member of audit_alert_type must appear in exactly one bucket.
const TYPE_FILTERS: Record<string, { label: string; types: string[] }> = {
  hts: {
    label: "Classification",
    types: ["hts_discrepancy", "invoice_hts_mismatch"],
  },
  // Not a variance — the filing was right on its day. A refund lead.
  reclassified: { label: "Reclassified", types: ["hts_reclassified"] },
  origin: { label: "Origin", types: ["coo_discrepancy"] },
  value: { label: "Value", types: ["value_mismatch"] },
  quantity: { label: "Quantity", types: ["quantity_discrepancy"] },
  duty: {
    label: "Duty",
    types: [
      "rate_mismatch",
      "amount_mismatch",
      "missing_measure",
      "unexpected_measure",
    ],
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

export default async function VariancePage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const [rows, { type }] = await Promise.all([
    getVarianceQueue(),
    searchParams,
  ]);

  const activeType = type && TYPE_FILTERS[type] ? type : null;

  // The queue carries every status; the tiles report only what's open —
  // decided rows exist solely for the table's archived view.
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
          hint="across all entries"
        />
        <StatTile
          label="Recoverable"
          value={recoverable > 0 ? `+${formatCents(recoverable)}` : "—"}
          tone={recoverable > 0 ? "green" : "default"}
          hint="overpaid duty you can claim back"
        />
        <StatTile
          label="Exposure"
          value={exposure > 0 ? `−${formatCents(exposure)}` : "—"}
          tone={exposure > 0 ? "red" : "default"}
          hint="underpaid duty CBP can come for"
        />
        <StatTile
          label="Nearest window"
          value={
            nearest?.window.daysLeft != null
              ? `${nearest.window.daysLeft}d`
              : "—"
          }
          hint={
            nearest?.window.estDate
              ? `est. liquidation ${formatDate(nearest.window.estDate)}`
              : "no open windows"
          }
        />
      </div>

      <VarianceView
        groups={active}
        archivedGroups={archived}
        typeFilters={TYPE_FILTERS}
        activeType={activeType}
      />
    </div>
  );
}

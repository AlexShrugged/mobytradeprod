import { EntriesView } from "@/components/entries/entries-view";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { StatTile } from "@/components/stat-tile";
import {
  getEntries,
  getEntrySummaryStats,
  getFutureEntries,
} from "@/lib/db/queries/entries";
import { parseSetParam } from "@/lib/filter-params";
import { formatCents } from "@/lib/format";
import { parsePageParams } from "@/lib/pagination";
import { ENTRY_PHASES } from "@/lib/variance/window";

export const dynamic = "force-dynamic";

export default async function EntriesPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    per?: string;
    q?: string;
    phase?: string;
  }>;
}) {
  const params = await searchParams;
  const { page: requestedPage, per } = parsePageParams(params);
  const q = (params.q ?? "").trim() || null;
  const phases = parseSetParam(params.phase, ENTRY_PHASES);

  const [
    { rows: entries, totalCount, filteredCount, page, phaseCounts },
    allFutureEntries,
  ] = await Promise.all([
    getEntries({ page: requestedPage, per, q, phases }),
    getFutureEntries(),
  ]);
  // Reuses the future entries above so the projection runs once. Stats
  // always cover the whole org — filters narrow the list, never the tiles.
  const stats = await getEntrySummaryStats(allFutureEntries);

  // Projections have no phase: they belong to the pre-submission side of
  // the ledger, so the band rides along while Unsubmitted is checked, and
  // the search matches their shipment/port/PO facts.
  const ql = q?.toLowerCase();
  const futureEntries = phases.has("unsubmitted")
    ? allFutureEntries.filter(
        (f) =>
          ql === undefined ||
          f.shipmentNumber.toLowerCase().includes(ql) ||
          (f.portOfEntry ?? "").toLowerCase().includes(ql) ||
          f.purchaseOrders.some(
            (po) =>
              po.poNumber.toLowerCase().includes(ql) ||
              (po.supplierName ?? "").toLowerCase().includes(ql),
          ),
      )
    : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Entries"
        info="Customs entries with linked shipments and purchase orders, plus projected entries for goods still on the water. Expand a row for links, open an entry for full costs."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Duties & fees YTD"
          value={formatCents(stats.dutiesAndFeesYtdCents)}
          tone="red"
          hint={`across ${stats.ytdEntryCount} entr${stats.ytdEntryCount === 1 ? "y" : "ies"} this year`}
        />
        <StatTile
          label="Refunds"
          value={formatCents(stats.refundTotalCents)}
          tone="green"
          hint={`${formatCents(stats.refundPaidCents)} received · ${formatCents(stats.refundPendingCents)} pending`}
        />
        <StatTile
          label="Open audit findings"
          value={String(stats.openAlertCount)}
          tone={stats.openAlertCount > 0 ? "amber" : "default"}
          hint="expected vs declared, from deterministic rules"
        />
        <StatTile
          label="In-transit exposure"
          value={<Money cents={stats.inTransitExposureCents} estimate />}
          hint={`est. duties on ${stats.futureEntryCount} shipment${stats.futureEntryCount === 1 ? "" : "s"} without an entry`}
        />
      </div>

      {/* Future entries first: the money that is still avoidable belongs
          above the money already owed. Projections ride page 1 only — they
          are a band above the list, not part of the paged history. */}
      <EntriesView
        rows={[...(page === 1 ? futureEntries : []), ...entries]}
        totalCount={totalCount}
        filteredCount={filteredCount}
        phaseCounts={phaseCounts}
        page={page}
        per={per}
        initialQuery={q ?? ""}
        initialPhases={[...phases]}
      />
    </div>
  );
}

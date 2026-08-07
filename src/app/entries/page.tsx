import { EntriesTable } from "@/components/entries/entries-table";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { StatTile } from "@/components/stat-tile";
import {
  getEntries,
  getEntrySummaryStats,
  getFutureEntries,
} from "@/lib/db/queries/entries";
import { formatCents } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function EntriesPage() {
  const [entries, futureEntries] = await Promise.all([
    getEntries(),
    getFutureEntries(),
  ]);
  // Reuses the future entries above so the projection runs once.
  const stats = await getEntrySummaryStats(futureEntries);

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
          above the money already owed. */}
      <EntriesTable rows={[...futureEntries, ...entries]} />
    </div>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  FileText,
  Paperclip,
  ReceiptText,
  Ship,
  type LucideIcon,
} from "lucide-react";

import { AlertList } from "@/components/entries/alert-list";
import { DutiesPopover } from "@/components/entries/duties-popover";
import { LineItemsTable } from "@/components/entries/line-items-table";
import { DocumentRail } from "@/components/document-rail";
import { StatTile } from "@/components/stat-tile";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { DutyBucket } from "@/lib/duty/authority";
import { getEntryDetail, type EntryDocument } from "@/lib/db/queries/entries";
import { liquidationWindow } from "@/lib/variance/window";
import { formatCents, formatDate, formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const centsOf = (v: string | null): number | null =>
  v === null ? null : Math.round(Number(v) * 100);

// Fixed entity→color mapping over the app's chart tokens (palette validated
// per the dataviz method: legend direct-labels every segment, 2px surface
// gaps separate them). Colors follow the authority, never its rank; rare
// tail buckets and fees fold into muted grays rather than minting hues.
const BUCKET_COLORS: Record<DutyBucket, string> = {
  base_duty: "var(--chart-1)",
  section_301: "var(--chart-2)",
  section_232_steel: "var(--chart-3)",
  section_232_aluminum: "var(--chart-3)",
  section_232: "var(--chart-3)",
  ieepa: "var(--chart-4)",
  reciprocal: "var(--chart-5)",
  other_ch99: "color-mix(in oklab, var(--muted-foreground) 55%, transparent)",
  antidumping: "color-mix(in oklab, var(--muted-foreground) 70%, transparent)",
  countervailing:
    "color-mix(in oklab, var(--muted-foreground) 70%, transparent)",
  mpf: "color-mix(in oklab, var(--muted-foreground) 40%, transparent)",
  hmf: "color-mix(in oklab, var(--muted-foreground) 25%, transparent)",
  other_fee: "color-mix(in oklab, var(--muted-foreground) 40%, transparent)",
};

export default async function EntryDetailPage({
  params,
}: {
  params: Promise<{ entryId: string }>;
}) {
  const { entryId } = await params;
  const entry = await getEntryDetail(entryId);
  if (!entry) notFound();

  const openAlertCount = entry.alerts.filter((a) => a.status === "open").length;
  const duty = centsOf(entry.totalDuty);
  const base = centsOf(entry.totalBaseDuty);
  const breakdownTotal = entry.authorityBreakdown.reduce(
    (sum, b) => sum + b.amountCents,
    0,
  );
  const window = liquidationWindow(
    entry.entryDate,
    entry.status,
    new Date().toISOString().slice(0, 10),
  );

  // Open alerts grouped per line — entry.alerts is already open-first,
  // severity ordered, so index 0 is each line's worst finding (the Review
  // button's jump) and the full list renders inline under the row.
  const openAlertsByLineNumber: Record<number, typeof entry.alerts> = {};
  for (const a of entry.alerts) {
    if (a.status !== "open" || a.lineNumber === null) continue;
    (openAlertsByLineNumber[a.lineNumber] ??= []).push(a);
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
          <Link href="/entries">
            <ArrowLeft /> Back to entries
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">
            Entry {entry.entryNumber}
          </h1>
          <StatusBadge status={entry.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          {formatDate(entry.entryDate)} · {entry.portOfEntry ?? "port unknown"}
          {entry.entryType ? ` · type ${entry.entryType}` : ""}
          {entry.importerOfRecord ? ` · ${entry.importerOfRecord}` : ""}
          {!window.closed && window.estDate
            ? ` · est. liquidation ${formatDate(window.estDate)} · ${window.daysLeft}d left`
            : ""}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatTile label="Lines" value={String(entry.lineItems.length)} />
        <StatTile
          label="Entered value"
          value={formatMoney(entry.totalEnteredValue)}
        />
        <StatTile
          label="Duties & fees"
          value={
            <DutiesPopover
              total={centsOf(entry.dutiesAndFeesTotal)}
              base={base}
              additional={duty !== null && base !== null ? duty - base : null}
              mpf={centsOf(entry.mpfAmount)}
              hmf={centsOf(entry.hmfAmount)}
              sailBasis={entry.sailBasis === "exact" ? null : entry.sailBasis}
              align="start"
            />
          }
          hint="click for the breakdown"
        />
        <StatTile
          label="Refund"
          value={formatMoney(entry.totalRefund)}
          tone={entry.totalRefund !== null ? "green" : "default"}
        />
        <StatTile
          label="Open variances"
          value={String(openAlertCount)}
          tone={openAlertCount > 0 ? "amber" : "default"}
          hint={openAlertCount > 0 ? "see line state pills" : "all clear"}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Line items</CardTitle>
          <CardDescription>
            Declared 7501 lines. Flagged lines show their findings inline and
            link to their reconciliation; hover a line&apos;s duties &amp;
            fees for its charge-by-charge breakdown.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LineItemsTable
            lineItems={entry.lineItems}
            openAlertsByLineNumber={openAlertsByLineNumber}
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          {entry.authorityBreakdown.length > 0 && breakdownTotal > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Duty by authority</CardTitle>
                <CardDescription>
                  Declared charges bucketed by trade-measure authority.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {/* One proportional bar; 2px gaps keep segments legible and
                    the legend below carries identity + amounts (never color
                    alone). */}
                <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-full">
                  {entry.authorityBreakdown.map((bucket) => (
                    <div
                      key={bucket.bucket}
                      className="h-full rounded-[2px]"
                      style={{
                        flexGrow: bucket.amountCents,
                        flexBasis: 0,
                        minWidth: "6px",
                        background: BUCKET_COLORS[bucket.bucket],
                      }}
                      title={`${bucket.label} — ${formatCents(bucket.amountCents)}${
                        bucket.maxRate !== null
                          ? ` (${(bucket.maxRate * 100).toFixed(2).replace(/\.?0+$/, "")}%)`
                          : ""
                      }`}
                    />
                  ))}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
                  {entry.authorityBreakdown.map((bucket) => (
                    <span
                      key={bucket.bucket}
                      className="inline-flex items-center gap-1.5"
                    >
                      <span
                        className="size-2.5 shrink-0 rounded-[3px]"
                        style={{ background: BUCKET_COLORS[bucket.bucket] }}
                      />
                      <span className="text-muted-foreground">
                        {bucket.label}
                      </span>
                      <span className="font-medium tabular-nums">
                        {formatCents(bucket.amountCents)}
                      </span>
                    </span>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Audit findings</CardTitle>
              <CardDescription>
                {openAlertCount === 0
                  ? "Nothing open — declared charges match our reference data."
                  : `${openAlertCount} open finding${openAlertCount === 1 ? "" : "s"} — expected vs declared, from deterministic rules.`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AlertList alerts={entry.alerts} />
            </CardContent>
          </Card>

          {entry.refundClaims.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Refund status</CardTitle>
                <CardDescription>
                  From ACE refund reports, matched by entry number.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {entry.refundClaims.map((claim) => (
                  <div
                    key={claim.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <StatusBadge status={claim.stage} />
                      <div>
                        <div className="text-sm font-medium">
                          {claim.claimType}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {claim.refundNumber
                            ? `Refund #${claim.refundNumber} · `
                            : ""}
                          {claim.claimStatus ?? "—"}
                          {claim.refundStatus ? ` · ${claim.refundStatus}` : ""}
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                        {formatMoney(claim.totalAmount)}
                      </div>
                      <div className="text-xs text-muted-foreground tabular-nums">
                        {formatMoney(claim.classAmount)} +{" "}
                        {formatMoney(claim.interestAmount)} interest
                      </div>
                      <div className="text-xs text-muted-foreground">
                        liquidated {formatDate(claim.liquidationDate)}
                        {claim.refundDate
                          ? ` · refunded ${formatDate(claim.refundDate)}`
                          : ""}
                      </div>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Linked records</CardTitle>
            </CardHeader>
            {/* Ordered by proximity to the entry itself: what CBP received,
                then what the seller billed, then how it moved, then what was
                ordered. Reads outward from the filing. */}
            <CardContent className="flex flex-col gap-4">
              {/* Paperwork hangs off the entry itself, so there is no record
                  title to head each row — the rail is the group's whole
                  content, sitting directly in the group box. */}
              {entry.entryPaperwork.length > 0 ? (
                <RecordGroup
                  icon={Paperclip}
                  label="Entry paperwork"
                  empty={false}
                >
                  <div className="py-2">
                    <DocumentRail documents={entry.entryPaperwork} />
                  </div>
                </RecordGroup>
              ) : null}
              <RecordGroup
                icon={ReceiptText}
                label="Commercial invoices"
                empty={entry.invoices.length === 0}
              >
                {entry.invoices.map((inv) => (
                  <RecordRow
                    key={inv.id}
                    title={inv.invoiceNumber}
                    meta={
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {inv.totalAmount
                          ? formatMoney(inv.totalAmount, inv.currency)
                          : null}
                        {inv.entryCount > 1
                          ? `${inv.totalAmount ? " · " : ""}spans ${inv.entryCount} entries`
                          : null}
                      </span>
                    }
                    documents={inv.documents}
                  />
                ))}
              </RecordGroup>
              <RecordGroup
                icon={Ship}
                label="Shipments"
                empty={entry.shipments.length === 0}
              >
                {entry.shipments.map((s) => (
                  <RecordRow
                    key={s.id}
                    title={s.shipmentNumber}
                    meta={<StatusBadge status={s.status} />}
                    documents={s.documents}
                  />
                ))}
              </RecordGroup>
              <RecordGroup
                icon={FileText}
                label="Purchase orders"
                empty={entry.purchaseOrders.length === 0}
              >
                {entry.purchaseOrders.map((po) => (
                  <RecordRow
                    key={po.id}
                    title={po.poNumber}
                    meta={
                      po.totalAmount ? (
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {formatMoney(po.totalAmount, po.currency)}
                        </span>
                      ) : undefined
                    }
                    documents={po.documents}
                  />
                ))}
              </RecordGroup>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function RecordGroup({
  icon: Icon,
  label,
  empty,
  children,
}: {
  icon: LucideIcon;
  label: string;
  empty: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </h4>
      {empty ? (
        <span className="text-sm text-muted-foreground">None</span>
      ) : (
        // One box per group, not per record: the border marks the group, and
        // records inside it are separated by rules. Keeps all four groups the
        // same shape whether they hold records or a bare document rail.
        <div className="divide-y rounded-md border px-3">{children}</div>
      )}
    </div>
  );
}

// One business record with the paperwork homed under it. The document rows
// are the click targets — with no shipment/PO/invoice pages, the source
// paper IS the drill-down.
function RecordRow({
  title,
  meta,
  documents,
}: {
  title: string;
  meta?: React.ReactNode;
  documents: EntryDocument[];
}) {
  // Full weight only when there is a file behind the row. Without one there is
  // nothing to open, so the title drops to the muted ramp — the same contrast
  // the rail's file names carry, so weight alone reads as "openable".
  const hasDocuments = documents.length > 0;
  return (
    <div className="py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          className={cn(
            "text-sm tabular-nums",
            hasDocuments
              ? "font-medium"
              : "font-normal text-muted-foreground",
          )}
        >
          {title}
        </span>
        {meta}
      </div>
      {hasDocuments ? (
        <div className="mt-1.5">
          <DocumentRail documents={documents} />
        </div>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">
          No document on file yet.
        </p>
      )}
    </div>
  );
}

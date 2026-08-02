import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileText, Ship } from "lucide-react";

import { AlertList } from "@/components/entries/alert-list";
import { DutiesPopover } from "@/components/entries/duties-popover";
import { LineItemsTable } from "@/components/entries/line-items-table";
import { DocumentChip } from "@/components/document-chip";
import { StatTile } from "@/components/stat-tile";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { DutyBucket } from "@/lib/duty/authority";
import { getEntryDetail } from "@/lib/db/queries/entries";
import { formatCents, formatDate, formatMoney } from "@/lib/format";

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
          label="Effective rate"
          value={
            entry.effectiveDutyRate === null
              ? "—"
              : `${(entry.effectiveDutyRate * 100).toFixed(2)}%`
          }
          hint="total duty / entered value"
        />
      </div>

      {entry.authorityBreakdown.length > 0 && breakdownTotal > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Duty by authority</CardTitle>
            <CardDescription>
              Declared charges bucketed by trade-measure authority.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {/* One proportional bar; 2px gaps keep segments legible and the
                legend below carries identity + amounts (never color alone). */}
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
                  <span className="text-muted-foreground">{bucket.label}</span>
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
                    <div className="text-sm font-medium">{claim.claimType}</div>
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Line items</CardTitle>
          <CardDescription>
            Declared 7501 lines. Expand a line for its charge-by-charge
            breakdown against the expected duty stack.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LineItemsTable lineItems={entry.lineItems} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Linked records &amp; source documents
          </CardTitle>
          <CardDescription>
            The shipments and purchase orders on this entry, and the
            paperwork behind it via provenance links.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-3">
            <div>
              <h4 className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
                <Ship className="size-4" /> Shipments
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {entry.shipments.length === 0 ? (
                  <span className="text-sm text-muted-foreground">None</span>
                ) : (
                  entry.shipments.map((s) => (
                    <Badge key={s.id} variant="outline" className="font-normal">
                      {s.shipmentNumber}
                    </Badge>
                  ))
                )}
              </div>
            </div>
            <div>
              <h4 className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
                <FileText className="size-4" /> Purchase orders
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {entry.purchaseOrders.length === 0 ? (
                  <span className="text-sm text-muted-foreground">None</span>
                ) : (
                  entry.purchaseOrders.map((po) => (
                    <Badge
                      key={po.id}
                      variant="outline"
                      className="font-normal"
                    >
                      {po.poNumber}
                      {po.totalAmount
                        ? ` · ${formatMoney(po.totalAmount, po.currency)}`
                        : ""}
                    </Badge>
                  ))
                )}
              </div>
            </div>
          </div>
          <div>
            <h4 className="mb-1.5 text-sm font-medium">Documents</h4>
            {entry.documents.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No documents linked to this entry yet.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {entry.documents.map((doc) => (
                  <li key={doc.id}>
                    <DocumentChip
                      fileName={doc.fileName}
                      docType={doc.docType}
                      fileSize={doc.fileSize}
                      created={doc.created}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

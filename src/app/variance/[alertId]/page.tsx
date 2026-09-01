import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { DocumentRail } from "@/components/document-rail";
import { StatusBadge } from "@/components/status-badge";
import { AlertActions } from "@/components/variance/alert-actions";
import { LineLedger } from "@/components/variance/line-ledger";
import { VarianceNavCard } from "@/components/variance/variance-nav-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AiVarianceDetailView } from "@/components/variance/ai-variance-detail";
import {
  getAiVarianceDetail,
  getVarianceDetail,
} from "@/lib/db/queries/variance";
import { formatDate, formatHts, formatMoney } from "@/lib/format";
import {
  nextOpenSiblingId,
  pairSiblingAlerts,
  unitIds,
  unitStatus,
} from "@/lib/variance/grouping";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function VarianceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ alertId: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { alertId } = await params;
  // ?from=entry marks a review flow entered from the entry page: in-flow
  // navigation carries it along, and both "done" and browser-back land on
  // the entry rather than the variance queue.
  const fromEntry = (await searchParams).from === "entry";
  const detail = await getVarianceDetail(alertId);
  if (!detail) {
    // Not an audit alert: the id may be an AI analysis finding — same
    // route, so mixed lines hop between rule and AI issues seamlessly.
    const ai = await getAiVarianceDetail(alertId);
    if (!ai) notFound();
    if (ai.finding.lineItemId === null) redirect(`/entries/${ai.entry.id}`);
    return <AiVarianceDetailView detail={ai} fromEntry={fromEntry} />;
  }
  // Entry-scoped variances (no line) reconcile on the entry page itself.
  if (detail.alert.lineItemId === null) redirect(`/entries/${detail.entry.id}`);

  const {
    alert,
    entry,
    window,
    line,
    catalogExpected,
    documents,
    invoices,
    siblings,
  } = detail;
  // Decisions operate on UNITS: a rate mismatch and its duty-amount twin
  // decide together (pairSiblingAlerts) — advance, undo, and the completion
  // summary all count units, and a unit's primary page is where links land.
  const units = pairSiblingAlerts(siblings);
  const unitRows = units.map((u) => ({
    id: u.primary.id,
    ids: unitIds(u),
    status: unitStatus(u),
    // A unit's decision moment: the latest member stamp (twins decide
    // together; either carries it). 0 while open or for legacy rows.
    decidedAt: Math.max(
      0,
      ...[u.primary, u.consequence]
        .filter((m) => m !== null)
        .map((m) => m.resolvedAt?.getTime() ?? 0),
    ),
  }));
  const currentUnit = unitRows.find((u) => u.ids.includes(alert.id)) ?? null;
  const decideIds = currentUnit?.ids ?? [alert.id];
  const nextOpenAlertId = nextOpenSiblingId(
    unitRows,
    currentUnit?.id ?? alert.id,
  );
  // Inline Undo target: the line's most recently decided unit — "the one I
  // just accepted/dismissed" — regardless of where it re-sorted in card
  // order. Card position won't do: the decided band sorts canonically (by
  // impact), not chronologically.
  const undoPrevious = unitRows
    .filter((u) => u.status !== "open" && !u.ids.includes(alert.id))
    .reduce<{ ids: string[]; backTo: string; decidedAt: number } | null>(
      (best, u) =>
        best === null || u.decidedAt > best.decidedAt
          ? { ids: u.ids, backTo: u.id, decidedAt: u.decidedAt }
          : best,
      null,
    );
  const d = alert.details ?? {};
  const str = (k: string) =>
    typeof d[k] === "string" ? (d[k] as string) : null;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
          <Link href={fromEntry ? `/entries/${entry.id}` : "/variance"}>
            <ArrowLeft />{" "}
            {fromEntry
              ? `Back to entry ${entry.entryNumber}`
              : "Back to variance"}
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">
            {alert.label}
          </h1>
          <StatusBadge status={alert.alertType} />
          {alert.status !== "open" ? (
            <Badge variant="secondary" className="font-normal">
              {alert.status === "resolved" ? "accepted" : alert.status}
            </Badge>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          <Link
            href={`/entries/${entry.id}`}
            className="tabular-nums hover:underline"
          >
            Entry {entry.entryNumber}
          </Link>
          {line ? ` · line ${line.lineNumber}` : ""}
          {line?.sku ? ` · ${line.sku}` : ""}
          {entry.entryDate ? ` · filed ${formatDate(entry.entryDate)}` : ""}
          {window.phase === "liquidated"
            ? " · liquidated"
            : window.phase === "unsubmitted" && window.nextPhaseDate
              ? ` · unsubmitted · editable without PSC until ${formatDate(window.nextPhaseDate)}`
              : window.nextPhaseDate
                ? ` · submitted · est. liquidation ${formatDate(window.nextPhaseDate)} · ${window.daysLeft}d left`
                : ""}
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <LineLedger
            currentId={alert.id}
            currentDetails={d}
            line={line}
            catalogExpected={catalogExpected}
            documents={documents}
            siblings={siblings}
            fromEntry={fromEntry}
          />
          <div className="mt-4">
            <AlertActions
              alertId={alert.id}
              status={alert.status}
              alertType={alert.alertType}
              partId={alert.partId}
              entryId={entry.id}
              fromEntry={fromEntry}
              decideIds={decideIds}
              nextOpenAlertId={nextOpenAlertId}
              undoPrevious={undoPrevious}
              lineUnits={unitRows.map((u) => ({
                ids: u.ids,
                status: u.status,
              }))}
            />
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <VarianceNavCard
            siblings={siblings}
            currentId={alert.id}
            fromEntry={fromEntry}
            actions={
              <AlertActions
                compact
                alertId={alert.id}
                status={alert.status}
                alertType={alert.alertType}
                partId={alert.partId}
                entryId={entry.id}
                fromEntry={fromEntry}
                decideIds={decideIds}
                nextOpenAlertId={nextOpenAlertId}
                lineUnits={unitRows.map((u) => ({
                  ids: u.ids,
                  status: u.status,
                }))}
              />
            }
          />

          {invoices.map((inv) => (
            <Card key={inv.id}>
              <CardHeader>
                <CardTitle className="text-base">
                  Invoice {inv.invoiceNumber}
                </CardTitle>
                <CardDescription>
                  {inv.supplierName ?? "Unknown supplier"}
                  {inv.invoiceDate ? ` · ${formatDate(inv.invoiceDate)}` : ""}
                  {inv.totalAmount
                    ? ` · ${formatMoney(Number(inv.totalAmount))} ${inv.currency}`
                    : ""}
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead>HTS</TableHead>
                      <TableHead>COO</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {inv.lines.map((li) => (
                      <TableRow
                        key={li.lineNumber}
                        className={cn(
                          li.sku !== null &&
                            li.sku === str("sku") &&
                            "bg-amber-50/50 dark:bg-amber-950/20",
                        )}
                      >
                        <TableCell className="font-medium">
                          {li.sku ?? "—"}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {li.htsCode ? formatHts(li.htsCode) : "—"}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {li.countryOfOrigin ?? "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {li.quantity ? Number(li.quantity) : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatMoney(Number(li.totalPrice))}
                        </TableCell>
                      </TableRow>
                    ))}
                    {/* The invoice's own arithmetic below the goods: the
                        adjustment rows it prints (a rebate credit, freight)
                        and the amount payable they lead to. */}
                    {inv.adjustments.map((a, i) => (
                      <TableRow
                        key={`adjustment-${i}`}
                        className="text-muted-foreground"
                      >
                        <TableCell colSpan={4}>{a.label}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatMoney(Number(a.amount))}
                        </TableCell>
                      </TableRow>
                    ))}
                    {inv.adjustments.length > 0 && inv.totalAmount ? (
                      <TableRow className="font-medium">
                        <TableCell colSpan={4}>Total payable</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatMoney(Number(inv.totalAmount))}
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ))}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Documents on file</CardTitle>
            </CardHeader>
            <CardContent>
              {documents.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No documents linked to this entry yet.
                </p>
              ) : (
                <DocumentRail documents={documents} />
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

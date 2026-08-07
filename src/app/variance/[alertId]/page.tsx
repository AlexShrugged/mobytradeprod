import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { DocumentRail } from "@/components/document-rail";
import { HtsCode } from "@/components/hts-code";
import { StatusBadge } from "@/components/status-badge";
import { AlertActions } from "@/components/variance/alert-actions";
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
import { getVarianceDetail } from "@/lib/db/queries/variance";
import {
  formatCents,
  formatDate,
  formatHts,
  formatMoney,
  formatRate,
} from "@/lib/format";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const severityLabel = {
  error: { text: "High", tone: "text-red-600 dark:text-red-400" },
  warning: { text: "Medium", tone: "text-amber-600 dark:text-amber-400" },
  info: { text: "Low", tone: "text-blue-600 dark:text-blue-400" },
} as const;

function htsDivergence(a: string, b: string): string {
  const da = a.replace(/\D/g, "");
  const db = b.replace(/\D/g, "");
  if (da.slice(0, 4) !== db.slice(0, 4)) return "heading differs";
  if (da.slice(4, 6) !== db.slice(4, 6)) return "subheading differs";
  return "statistical suffix differs";
}

function ImpactText({
  impactCents,
  direction,
  className,
}: {
  impactCents: number | null;
  direction: "recoverable" | "exposure" | null;
  className?: string;
}) {
  if (impactCents === null)
    return <span className={cn("text-muted-foreground", className)}>—</span>;
  return (
    <span
      className={cn(
        "font-medium tabular-nums",
        direction === "recoverable" && "text-emerald-700 dark:text-emerald-400",
        direction === "exposure" && "text-red-700 dark:text-red-400",
        direction === null && "text-muted-foreground",
      )}
      title={
        direction === "recoverable"
          ? "Overpaid — recoverable"
          : direction === "exposure"
            ? "Underpaid — exposure"
            : undefined
      }
    >
      {direction === "recoverable" ? "+" : direction === "exposure" ? "−" : ""}
      {formatCents(Math.abs(impactCents))}
      {direction ? (
        <span className="ml-1 font-normal text-muted-foreground">
          {direction === "recoverable" ? "recoverable" : "exposure"}
        </span>
      ) : null}
    </span>
  );
}

type DiffRow = {
  field: string;
  expected: React.ReactNode;
  filed: React.ReactNode;
  delta: React.ReactNode;
  changed?: boolean;
};

export default async function VarianceDetailPage({
  params,
}: {
  params: Promise<{ alertId: string }>;
}) {
  const { alertId } = await params;
  const detail = await getVarianceDetail(alertId);
  if (!detail) notFound();
  // Entry-scoped variances (no line) reconcile on the entry page itself.
  if (detail.alert.lineItemId === null) redirect(`/entries/${detail.entry.id}`);

  const {
    alert,
    entry,
    window,
    line,
    impact,
    catalogExpected,
    documents,
    invoices,
  } = detail;
  const d = alert.details ?? {};
  const str = (k: string) =>
    typeof d[k] === "string" ? (d[k] as string) : null;
  const numV = (k: string) =>
    typeof d[k] === "number" ? (d[k] as number) : null;
  const sev = severityLabel[alert.severity];

  const muted = (text: string) => (
    <span className="text-muted-foreground">{text}</span>
  );
  const amber = (node: React.ReactNode) => (
    <span className="text-amber-700 dark:text-amber-400">{node}</span>
  );

  // ------------------------------------------------- the field-level diff
  const rows: DiffRow[] = [];
  const declaredHts = line?.htsCode ?? str("actual_hts");
  const catalogHts = line?.catalogHtsCode ?? str("expected_hts");

  const currentHts = line?.catalogHtsCodeCurrent ?? str("expected_hts_current");

  // The Expected column is the world under the expected classification all
  // the way down — rate and computed duty included — so the counterfactual
  // stack renders as diff rows, not a separate card.
  const declaredBaseRateStr =
    line?.charges.find((c) => c.chargeType === "base_duty")?.rate ?? null;
  const expectedStackSummary = catalogExpected
    ? [
        catalogExpected.baseDuty
          ? catalogExpected.baseDuty.rate === 0
            ? "free base"
            : `base ${formatRate(catalogExpected.baseDuty.rate)}`
          : null,
        ...catalogExpected.measures.map(
          (m) => `${m.name} ${formatRate(m.rate)}`,
        ),
      ]
        .filter(Boolean)
        .join(" + ")
    : null;

  const catalogDutyRows = (): DiffRow[] => {
    if (!catalogExpected) return [];
    const out: DiffRow[] = [];
    const expRate = catalogExpected.baseDuty?.rate ?? null;
    if (expRate !== null) {
      const decRate =
        declaredBaseRateStr === null ? null : Number(declaredBaseRateStr);
      const pts =
        decRate === null ? null : Math.round((decRate - expRate) * 10000) / 100;
      out.push({
        field: "Duty rate",
        expected: <span className="tabular-nums">{formatRate(expRate)}</span>,
        filed:
          decRate === null ? (
            muted("none declared")
          ) : pts !== 0 ? (
            amber(<span className="tabular-nums">{formatRate(decRate)}</span>)
          ) : (
            <span className="tabular-nums">{formatRate(decRate)}</span>
          ),
        delta:
          pts === null
            ? muted("—")
            : pts === 0
              ? muted("match")
              : amber(
                  <span className="tabular-nums">{`${pts > 0 ? "+" : ""}${pts} pts`}</span>,
                ),
        changed: pts !== null && pts !== 0,
      });
    }
    if (
      catalogExpected.totalCents !== null &&
      catalogExpected.declaredDutyCents !== null
    ) {
      out.push({
        field: "Duty",
        expected: (
          <span className="tabular-nums">
            {formatCents(catalogExpected.totalCents)}
            {expectedStackSummary ? (
              <span className="block text-xs font-normal text-muted-foreground">
                {expectedStackSummary}
              </span>
            ) : null}
          </span>
        ),
        filed: (
          <span className="tabular-nums">
            {formatCents(catalogExpected.declaredDutyCents)}
          </span>
        ),
        delta: <ImpactText {...impact} />,
        changed: true,
      });
    }
    return out;
  };

  const invoiceHts = str("expected_hts");
  if (alert.alertType === "invoice_hts_mismatch" && declaredHts && invoiceHts) {
    rows.push({
      field: "HTS",
      expected: (
        <span className="inline-flex items-center gap-1.5">
          <HtsCode code={invoiceHts} />
          <span className="text-xs text-muted-foreground">per invoice</span>
        </span>
      ),
      filed: <HtsCode code={declaredHts} compareTo={invoiceHts} />,
      delta: amber(htsDivergence(declaredHts, invoiceHts)),
      changed: true,
    });
  } else if (
    alert.alertType === "hts_discrepancy" &&
    declaredHts &&
    catalogHts
  ) {
    rows.push({
      field: "HTS",
      expected: <HtsCode code={catalogHts} />,
      filed: <HtsCode code={declaredHts} compareTo={catalogHts} />,
      delta: amber(htsDivergence(declaredHts, catalogHts)),
      changed: true,
    });
    rows.push(...catalogDutyRows());
  } else if (
    alert.alertType === "hts_reclassified" &&
    declaredHts &&
    currentHts
  ) {
    // Filed matched its day's catalog; the diff is against TODAY's
    // classification — the retroactive-correction counterfactual.
    rows.push({
      field: "HTS",
      expected: (
        <span className="inline-flex items-center gap-1.5">
          <HtsCode code={currentHts} />
          <span className="text-xs text-muted-foreground">
            now
            {str("current_effective_from")
              ? ` · eff ${str("current_effective_from")}`
              : ""}
          </span>
        </span>
      ),
      filed: <HtsCode code={declaredHts} compareTo={currentHts} />,
      delta: amber(htsDivergence(declaredHts, currentHts)),
      changed: true,
    });
    rows.push({
      field: "HTS at filing",
      expected: <HtsCode code={str("expected_hts_as_of") ?? declaredHts} />,
      filed: <HtsCode code={declaredHts} />,
      delta: muted("matched"),
    });
    rows.push(...catalogDutyRows());
  } else if (declaredHts) {
    rows.push({
      field: "HTS",
      expected: muted("—"),
      filed: <HtsCode code={declaredHts} />,
      delta: muted("—"),
    });
  }

  if (alert.alertType === "coo_discrepancy") {
    // The same alertType serves two evidence sources: an invoice_number in
    // details marks a CI-vs-entry finding, otherwise it's the catalog rule.
    const fromInvoice = str("invoice_number") !== null;
    const expectedCoo =
      str("expected_coo") ??
      (Array.isArray(d.expected_coos)
        ? (d.expected_coos as string[]).join(" / ")
        : null);
    rows.push({
      field: "Origin",
      expected: (
        <span className="tabular-nums">
          {expectedCoo ?? "—"}
          {fromInvoice ? (
            <span className="ml-1.5 text-xs text-muted-foreground">
              per invoice {str("invoice_number")}
            </span>
          ) : str("vendor_name") ? (
            <span className="ml-1.5 text-xs text-muted-foreground">
              via {str("vendor_name")}
            </span>
          ) : null}
        </span>
      ),
      filed: amber(str("declared_coo") ?? line?.countryOfOrigin ?? "—"),
      delta: amber(
        fromInvoice
          ? "differs from commercial invoice"
          : "differs from catalog sourcing",
      ),
      changed: true,
    });
  } else if (line?.countryOfOrigin) {
    rows.push({
      field: "Origin",
      expected: muted("—"),
      filed: <span className="tabular-nums">{line.countryOfOrigin}</span>,
      delta: muted("—"),
    });
  }

  if (alert.alertType === "rate_mismatch") {
    const expectedRate = numV("expected_rate");
    const actualRate = numV("actual_rate");
    const pts =
      expectedRate !== null && actualRate !== null
        ? Math.round((actualRate - expectedRate) * 10000) / 100
        : null;
    rows.push({
      field: "Duty rate",
      expected: (
        <span className="tabular-nums">{formatRate(expectedRate)}</span>
      ),
      filed: amber(
        <span className="tabular-nums">{formatRate(actualRate)}</span>,
      ),
      delta: (
        <span className="tabular-nums">
          {pts !== null ? `${pts > 0 ? "+" : ""}${pts} pts · ` : ""}
          <ImpactText {...impact} />
        </span>
      ),
      changed: true,
    });
  }

  if (alert.alertType === "amount_mismatch") {
    rows.push({
      field: "Duty amount",
      expected: (
        <span className="tabular-nums">
          {formatMoney(numV("expected_amount"))}
        </span>
      ),
      filed: amber(
        <span className="tabular-nums">
          {formatMoney(numV("actual_amount"))}
        </span>,
      ),
      delta: <ImpactText {...impact} />,
      changed: true,
    });
  }

  if (alert.alertType === "missing_measure") {
    rows.push({
      field: "Measure",
      expected: (
        <span>
          {str("measure_name") ?? "Base duty"}
          {str("expected_hts") ? (
            <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">
              {formatHts(str("expected_hts"))}
            </span>
          ) : null}{" "}
          <span className="tabular-nums">
            at {formatRate(numV("expected_rate"))}
          </span>
        </span>
      ),
      filed: amber("not declared"),
      delta: <ImpactText {...impact} />,
      changed: true,
    });
  }

  if (alert.alertType === "unexpected_measure") {
    rows.push({
      field: "Measure",
      expected: muted("not expected"),
      filed: amber(
        <span>
          {str("measure_name") ?? "measure"}{" "}
          <span className="tabular-nums">
            {formatMoney(numV("actual_amount"))}
          </span>
        </span>,
      ),
      delta: str("stacking_reason") ? (
        <ImpactText {...impact} />
      ) : (
        muted("possible coverage gap — review")
      ),
      changed: true,
    });
  }

  // CI-vs-entry findings: the invoice side is "expected", the 7501 "filed".
  if (
    alert.alertType === "value_mismatch" &&
    numV("expected_amount") !== null &&
    str("sku") !== null
  ) {
    rows.push({
      field: "Value",
      expected: (
        <span className="tabular-nums">
          {formatMoney(numV("expected_amount"))}
          <span className="ml-1.5 text-xs text-muted-foreground">
            per invoice
          </span>
        </span>
      ),
      filed: amber(
        <span className="tabular-nums">
          {formatMoney(numV("actual_amount"))}
        </span>,
      ),
      delta: <ImpactText {...impact} />,
      changed: true,
    });
  }

  if (alert.alertType === "quantity_discrepancy") {
    rows.push({
      field: "Quantity",
      expected: (
        <span className="tabular-nums">
          {numV("expected_quantity") ?? "—"}
          <span className="ml-1.5 text-xs text-muted-foreground">
            per invoice
          </span>
        </span>
      ),
      filed: amber(
        <span className="tabular-nums">{numV("actual_quantity") ?? "—"}</span>,
      ),
      delta: amber("differs from commercial invoice"),
      changed: true,
    });
  }

  if (alert.alertType === "invoice_sku_missing") {
    rows.push({
      field: "Invoice coverage",
      expected: muted("listed on a linked invoice"),
      filed: amber("not on any linked invoice"),
      delta: muted("possible ingestion gap — review"),
      changed: true,
    });
  }

  if (line) {
    rows.push(
      {
        field: "Entered value",
        expected: muted("—"),
        filed: (
          <span className="tabular-nums">{formatMoney(line.enteredValue)}</span>
        ),
        delta: muted("—"),
      },
      // quantity_discrepancy already renders its own Quantity diff row.
      ...(alert.alertType !== "quantity_discrepancy"
        ? [
            {
              field: "Quantity",
              expected: muted("—"),
              filed: (
                <span className="tabular-nums">
                  {line.quantity ? Number(line.quantity) : "—"}
                </span>
              ),
              delta: muted("—"),
            } satisfies DiffRow,
          ]
        : []),
      {
        field: "Supplier",
        expected: muted("—"),
        filed: <span>{line.supplierName ?? "—"}</span>,
        delta: muted("—"),
      },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
          <Link href="/variance">
            <ArrowLeft /> Back to variance
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">
            {alert.label}
          </h1>
          <StatusBadge status={alert.alertType} />
          <span className={cn("text-xs font-medium", sev.tone)}>
            {sev.text}
          </span>
          {alert.status !== "open" ? (
            <Badge variant="secondary" className="font-normal">
              {alert.status}
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
          {window.closed
            ? " · liquidated"
            : window.estDate
              ? ` · est. liquidation ${formatDate(window.estDate)} · ${window.daysLeft}d left`
              : ""}
        </p>
        <p className="mt-2 max-w-3xl text-sm">{alert.message}</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <div className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm">
            <Table className="[&_td]:py-3.5">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-36">Field</TableHead>
                  <TableHead className="border-l">Expected</TableHead>
                  <TableHead className="border-l">Filed</TableHead>
                  <TableHead className="border-l">Delta</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow
                    key={row.field}
                    className={cn(
                      row.changed && "bg-amber-50/50 dark:bg-amber-950/20",
                    )}
                  >
                    <TableCell className="text-muted-foreground">
                      {row.field}
                    </TableCell>
                    <TableCell className="border-l font-medium">
                      {row.expected}
                    </TableCell>
                    <TableCell className="border-l font-medium">
                      {row.filed}
                    </TableCell>
                    <TableCell className="border-l">{row.delta}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {!line ? (
            <p className="mt-3 text-sm text-muted-foreground">
              The flagged line was re-ingested and no longer exists — showing
              the facts the alert recorded when it fired.
            </p>
          ) : null}
          <div className="mt-4">
            <AlertActions
              alertId={alert.id}
              status={alert.status}
              alertType={alert.alertType}
              partId={alert.partId}
            />
          </div>
        </div>

        <div className="flex flex-col gap-4">
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

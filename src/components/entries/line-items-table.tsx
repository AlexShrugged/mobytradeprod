"use client";

import * as React from "react";
import Link from "next/link";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { Check, Info, OctagonAlert, TriangleAlert } from "lucide-react";

import { HtsCode } from "@/components/hts-code";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  AlertRow,
  LineChargeDetail,
  LineItemDetail,
} from "@/lib/db/queries/entries";
import { pairSiblingAlerts } from "@/lib/variance/grouping";
import { formatHts, formatMoney, formatRate } from "@/lib/format";
import { cn } from "@/lib/utils";

const openAlertTotal = (li: LineItemDetail) =>
  li.openAlerts.error + li.openAlerts.warning + li.openAlerts.info;

const severityMeta = {
  error: { icon: OctagonAlert, tone: "text-red-600 dark:text-red-400" },
  warning: { icon: TriangleAlert, tone: "text-amber-600 dark:text-amber-400" },
  info: { icon: Info, tone: "text-blue-600 dark:text-blue-400" },
} as const;

const chargeTypeLabel: Record<string, string> = {
  base_duty: "Base duty",
  additional_duty: "Additional duty",
  antidumping: "Antidumping",
  countervailing: "Countervailing",
  mpf: "MPF",
  hmf: "HMF",
  other_fee: "Fee",
};

// The program identity of a charge as it appears on the 7501: the line's own
// HTS for base duty, the Ch99 code for trade measures, the CBP fee class
// codes for MPF/HMF.
function chargeProgram(c: LineChargeDetail, lineHts: string) {
  if (c.chargeType === "mpf") return { code: "499", label: "MPF" };
  if (c.chargeType === "hmf") return { code: "501", label: "HMF" };
  if (c.chargeType === "base_duty")
    return { code: formatHts(lineHts), label: "Base duty" };
  return {
    code: c.htsCode ? formatHts(c.htsCode) : "—",
    label:
      c.measureName ?? chargeTypeLabel[c.chargeType] ?? c.chargeType,
  };
}

// Hover breakdown for a line's duties & fees — same shape as the entry-level
// DutiesPopover, one level deeper: each declared charge as program + amount.
function LineDutiesHover({ line }: { line: LineItemDetail }) {
  const amount = (
    <div className="text-right tabular-nums text-red-700 dark:text-red-400">
      {formatMoney(line.dutiesAndFees)}
    </div>
  );
  if (line.charges.length === 0) return amount;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="cursor-default underline-offset-2 decoration-dotted hover:underline">
          {amount}
        </div>
      </TooltipTrigger>
      <TooltipContent align="end" className="p-3">
        <div className="flex w-60 flex-col gap-1.5">
          {line.charges.map((c) => {
            const program = chargeProgram(c, line.htsCode);
            return (
              <div
                key={c.id}
                className="flex items-baseline justify-between gap-4"
              >
                <span className="min-w-0">
                  <span className="tabular-nums">{program.code}</span>
                  <span className="ml-1.5 opacity-60">{program.label}</span>
                  {c.rate !== null ? (
                    <span className="ml-1.5 tabular-nums opacity-60">
                      {formatRate(c.rate)}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 tabular-nums">
                  {formatMoney(c.amount)}
                </span>
              </div>
            );
          })}
          <div className="mt-0.5 flex justify-between gap-4 border-t border-background/25 pt-1.5 font-medium">
            <span>Duties &amp; fees</span>
            <span className="tabular-nums">
              {formatMoney(line.dutiesAndFees)}
            </span>
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

// A finding reduced to its field-level diff — the same expected/filed framing
// as the variance reconciliation page, compressed to one line.
function fieldIssue(
  a: AlertRow,
): { field: string; expected: string; filed: string } | null {
  const d = a.details ?? {};
  const s = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : null);
  const n = (k: string) => (typeof d[k] === "number" ? (d[k] as number) : null);
  switch (a.alertType) {
    case "hts_discrepancy":
    case "invoice_hts_mismatch": {
      const e = s("expected_hts");
      const f = s("actual_hts");
      return e && f
        ? { field: "HTS", expected: formatHts(e), filed: formatHts(f) }
        : null;
    }
    case "hts_reclassified": {
      const e = s("expected_hts_current") ?? s("expected_hts");
      const f = s("actual_hts");
      return e && f
        ? { field: "HTS", expected: `${formatHts(e)} (now)`, filed: formatHts(f) }
        : null;
    }
    case "coo_discrepancy": {
      const e =
        s("expected_coo") ??
        (Array.isArray(d.expected_coos)
          ? (d.expected_coos as string[]).join(" / ")
          : null);
      return {
        field: "Origin",
        expected: e ?? "—",
        filed: s("declared_coo") ?? "—",
      };
    }
    case "rate_mismatch":
      return {
        field: "Duty rate",
        expected: formatRate(n("expected_rate")),
        filed: formatRate(n("actual_rate")),
      };
    case "amount_mismatch":
      return {
        field: "Duty amount",
        expected: formatMoney(n("expected_amount")),
        filed: formatMoney(n("actual_amount")),
      };
    case "value_mismatch":
      return {
        field: "Value",
        expected: formatMoney(n("expected_amount")),
        filed: formatMoney(n("actual_amount")),
      };
    case "quantity_discrepancy":
      return {
        field: "Quantity",
        expected: String(n("expected_quantity") ?? "—"),
        filed: String(n("actual_quantity") ?? "—"),
      };
    case "missing_measure":
      return {
        field: s("measure_name") ?? "Measure",
        expected: `declared at ${formatRate(n("expected_rate"))}`,
        filed: "not declared",
      };
    case "unexpected_measure":
      return {
        field: s("measure_name") ?? "Measure",
        expected: "not expected",
        filed: formatMoney(n("actual_amount")),
      };
    case "invoice_sku_missing":
      return {
        field: "Invoice coverage",
        expected: "on a linked invoice",
        filed: "not on any linked invoice",
      };
    default:
      return null;
  }
}

// Declared 7501 lines, one row each. No drill-down expansion: the duty
// breakdown lives on hover over the Duties & fees cell, and lines with open
// findings show them inline beneath the row as field-level expected/filed
// diffs (each linking to its reconciliation page).
export function LineItemsTable({
  lineItems,
  openAlertsByLineNumber,
}: {
  lineItems: LineItemDetail[];
  /** Line number → open alerts, worst severity first. */
  openAlertsByLineNumber?: Record<number, AlertRow[]>;
}) {
  const columns = React.useMemo<ColumnDef<LineItemDetail>[]>(
    () => [
      {
        accessorKey: "lineNumber",
        header: "Line",
        cell: ({ row }) => (
          <span className="font-medium tabular-nums">
            {row.original.lineNumber}
          </span>
        ),
      },
      {
        accessorKey: "sku",
        header: "SKU",
        cell: ({ row }) => (
          <span className="font-medium">{row.original.sku ?? "—"}</span>
        ),
      },
      {
        accessorKey: "description",
        header: "Description",
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {row.original.description ?? "—"}
          </span>
        ),
      },
      {
        accessorKey: "htsCode",
        header: "HTS",
        cell: ({ row }) => (
          <div className="flex flex-col gap-0.5">
            <HtsCode
              code={row.original.htsCode}
              compareTo={row.original.catalogHtsCode}
            />
            {row.original.htsMismatch && row.original.catalogHtsCode ? (
              row.original.partId ? (
                <Badge
                  variant="outline"
                  className="w-fit border-amber-300 font-normal text-amber-700 dark:border-amber-800 dark:text-amber-400"
                  title="The parts catalog classifies this part differently — review its classification"
                  asChild
                >
                  <Link href={`/parts?review=${row.original.partId}`}>
                    internal {row.original.catalogHtsCode}
                  </Link>
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="w-fit border-amber-300 font-normal text-amber-700 dark:border-amber-800 dark:text-amber-400"
                  title="The parts catalog classifies this part differently"
                >
                  internal {row.original.catalogHtsCode}
                </Badge>
              )
            ) : null}
            {!row.original.htsMismatch &&
            row.original.catalogHtsCodeCurrent &&
            row.original.catalogHtsCode &&
            row.original.catalogHtsCodeCurrent !==
              row.original.catalogHtsCode ? (
              <Badge
                variant="outline"
                className="w-fit border-violet-300 font-normal text-violet-700 dark:border-violet-800 dark:text-violet-400"
                title="Filed under the classification of its day; the part has since been reclassified — duty may be retroactively recoverable"
              >
                now {row.original.catalogHtsCodeCurrent}
              </Badge>
            ) : null}
            {row.original.catalogProvisionalCode ? (
              <Badge
                variant="outline"
                className="w-fit font-normal text-muted-foreground"
                title="The catalog carries a provisional (unreviewed) code for this part; it does not drive findings"
              >
                provisional {row.original.catalogProvisionalCode}
              </Badge>
            ) : null}
          </div>
        ),
      },
      {
        accessorKey: "countryOfOrigin",
        header: "COO",
        cell: ({ row }) => row.original.countryOfOrigin ?? "—",
      },
      {
        accessorKey: "supplierName",
        header: "Supplier",
        cell: ({ row }) =>
          row.original.supplierName ? (
            <span title="As declared on this entry line — one entry can span vendors">
              {row.original.supplierName}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        accessorKey: "quantity",
        header: () => <div className="text-right">Qty</div>,
        cell: ({ row }) => (
          <div className="text-right tabular-nums">
            {row.original.quantity ? Number(row.original.quantity) : "—"}
          </div>
        ),
      },
      {
        accessorKey: "enteredValue",
        header: () => <div className="text-right">Entered value</div>,
        cell: ({ row }) => (
          <div className="text-right tabular-nums">
            {formatMoney(row.original.enteredValue)}
          </div>
        ),
      },
      {
        accessorKey: "dutiesAndFees",
        header: () => <div className="text-right">Duties &amp; fees</div>,
        cell: ({ row }) => <LineDutiesHover line={row.original} />,
      },
      {
        accessorKey: "landedValue",
        header: () => <div className="text-right">Landed cost</div>,
        cell: ({ row }) => (
          <div className="text-right font-medium tabular-nums">
            {formatMoney(row.original.landedValue)}
          </div>
        ),
      },
      {
        accessorKey: "landedPerUnit",
        header: () => <div className="text-right">Landed/unit</div>,
        cell: ({ row }) => (
          <div className="text-right tabular-nums">
            {row.original.landedPerUnit === null
              ? "—"
              : formatMoney(row.original.landedPerUnit)}
          </div>
        ),
      },
      {
        id: "state",
        header: "Audit",
        cell: ({ row }) => {
          if (openAlertTotal(row.original) === 0) {
            return (
              <span title="No open findings on this line">
                <Check
                  className="size-4 text-emerald-600 dark:text-emerald-400"
                  aria-label="No open findings on this line"
                />
              </span>
            );
          }
          // Same decidable units as the variance page: the link always
          // lands on a unit's PRIMARY, so click-through pages are exactly
          // the ones the queue offers. ?from=entry marks the flow's origin
          // so finishing the line (or browser back) returns here.
          const worst = pairSiblingAlerts(
            openAlertsByLineNumber?.[row.original.lineNumber] ?? [],
          )[0]?.primary;
          // Primary variant on purpose — same button as the variance page's
          // Resolve action; review is this row's primary action. xs size:
          // it sits inside a dense table row.
          return worst ? (
            <Button asChild size="xs">
              <Link
                href={`/variance/${worst.id}?from=entry`}
                title="Reconcile this line against its source documents"
              >
                Review
              </Link>
            </Button>
          ) : (
            <StatusBadge status="needs_review" />
          );
        },
      },
    ],
    [openAlertsByLineNumber],
  );

  const table = useReactTable({
    data: lineItems,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
  });

  return (
    <TooltipProvider delayDuration={150}>
      {/* A raw <table> on purpose: the shared <Table> wraps itself in an
          overflow-x-auto container, and this one sits directly in the card —
          no inner box, no horizontal scrollbar. Cells wrap instead
          (overriding the ui-kit's whitespace-nowrap) so the table fits the
          card width. */}
      <table className="w-full caption-bottom text-sm [&_td]:whitespace-normal [&_th]:whitespace-normal">
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={columns.length}
                className="h-24 text-center text-muted-foreground"
              >
                No line items ingested yet. Process this entry&apos;s 7501
                document on the Data page.
              </TableCell>
            </TableRow>
          ) : (
            table.getRowModel().rows.map((row) => {
              // One inline finding per decidable unit — the same fold the
              // variance page applies (a rate mismatch carries its
              // duty-amount twin), so this list and the reconciliation
              // page's navigator name the same items.
              const lineAlerts = pairSiblingAlerts(
                openAlertsByLineNumber?.[row.original.lineNumber] ?? [],
              );
              return (
                <React.Fragment key={row.id}>
                  <TableRow
                    className={cn(
                      lineAlerts.length > 0 &&
                        "border-b-0 bg-amber-500/5 hover:bg-amber-500/10",
                    )}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                  {lineAlerts.length > 0 ? (
                    <TableRow className="bg-amber-500/5 hover:bg-amber-500/10">
                      <TableCell
                        colSpan={columns.length}
                        className="py-2 pl-10 pt-0"
                      >
                        <div className="flex flex-col gap-1">
                          {lineAlerts.map((u) => {
                            const a = u.primary;
                            const meta = severityMeta[a.severity];
                            const SevIcon = meta.icon;
                            const issue = fieldIssue(a);
                            return (
                              <Link
                                key={a.id}
                                href={`/variance/${a.id}?from=entry`}
                                className="group flex w-fit flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"
                                title={a.message}
                              >
                                <SevIcon
                                  className={cn("size-3.5 shrink-0", meta.tone)}
                                />
                                <span className="font-medium">
                                  {issue?.field ?? a.label}
                                </span>
                                {issue ? (
                                  <span className="text-muted-foreground">
                                    expected{" "}
                                    <span className="font-medium text-foreground tabular-nums">
                                      {issue.expected}
                                    </span>
                                    {" · filed "}
                                    <span className="font-medium text-foreground tabular-nums">
                                      {issue.filed}
                                    </span>
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground">
                                    {a.message}
                                  </span>
                                )}
                                {u.consequence ? (
                                  <span className="text-muted-foreground">
                                    · duty amount follows
                                  </span>
                                ) : null}
                                <span className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                                  →
                                </span>
                              </Link>
                            );
                          })}
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : null}
                </React.Fragment>
              );
            })
          )}
        </TableBody>
      </table>
    </TooltipProvider>
  );
}

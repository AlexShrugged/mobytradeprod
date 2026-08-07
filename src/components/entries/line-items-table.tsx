"use client";

import * as React from "react";
import Link from "next/link";
import {
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { Check, ChevronDown, ChevronRight } from "lucide-react";

import { HtsCode } from "@/components/hts-code";
import { LineCharges } from "@/components/entries/line-charges";
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
import type { LineItemDetail } from "@/lib/db/queries/entries";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

const openAlertTotal = (li: LineItemDetail) =>
  li.openAlerts.error + li.openAlerts.warning + li.openAlerts.info;

// Same expansion pattern as the entries table, one level deeper: a 7501
// line row expands inline into its charges (see LineCharges). Lines with an
// open variance tint amber; their State pill jumps to the reconciliation
// page while the row click keeps toggling the expansion.
export function LineItemsTable({
  lineItems,
  varianceHrefByLineNumber,
}: {
  lineItems: LineItemDetail[];
  /** Line number → /variance/[alertId] for lines with an open finding. */
  varianceHrefByLineNumber?: Record<number, string>;
}) {
  const columns = React.useMemo<ColumnDef<LineItemDetail>[]>(
    () => [
      {
        id: "expander",
        header: () => null,
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={(e) => {
              // The whole row also toggles; without this the two handlers
              // cancel each other and the chevron appears dead.
              e.stopPropagation();
              row.toggleExpanded();
            }}
            aria-label={row.getIsExpanded() ? "Collapse line" : "Expand line"}
          >
            {row.getIsExpanded() ? <ChevronDown /> : <ChevronRight />}
          </Button>
        ),
      },
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
                  <Link
                    href={`/parts?review=${row.original.partId}`}
                    onClick={(e) => e.stopPropagation()}
                  >
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
        cell: ({ row }) => (
          <div className="text-right tabular-nums text-red-700 dark:text-red-400">
            {formatMoney(row.original.dutiesAndFees)}
          </div>
        ),
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
        header: "State",
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
          const href = varianceHrefByLineNumber?.[row.original.lineNumber];
          // Primary variant on purpose — same button as the variance page's
          // Resolve action; review is this row's primary action. xs size:
          // it sits inside a dense table row.
          return href ? (
            <Button asChild size="xs">
              <Link
                href={href}
                onClick={(e) => e.stopPropagation()}
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
    [varianceHrefByLineNumber],
  );

  const table = useReactTable({
    data: lineItems,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getRowCanExpand: () => true,
    getRowId: (row) => row.id,
  });

  return (
    // A raw <table> on purpose: the shared <Table> wraps itself in an
    // overflow-x-auto container, and this one sits directly in the card —
    // no inner box, no horizontal scrollbar. Cells wrap instead
    // (overriding the ui-kit's whitespace-nowrap) so the table fits the
    // card width.
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
          table.getRowModel().rows.map((row) => (
            <React.Fragment key={row.id}>
              <TableRow
                data-state={row.getIsExpanded() ? "selected" : undefined}
                className={cn(
                  "cursor-pointer",
                  openAlertTotal(row.original) > 0 && "bg-amber-500/5",
                )}
                onClick={row.getToggleExpandedHandler()}
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
              {row.getIsExpanded() && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={columns.length} className="p-0">
                    <LineCharges line={row.original} />
                  </TableCell>
                </TableRow>
              )}
            </React.Fragment>
          ))
        )}
      </TableBody>
    </table>
  );
}

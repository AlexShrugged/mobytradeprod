"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";

import { HtsCode } from "@/components/hts-code";
import { StatusBadge } from "@/components/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { VarianceQueueRow } from "@/lib/db/queries/variance";
import { LIQUIDATION_WINDOW_DAYS } from "@/lib/variance/window";
import {
  formatCents,
  formatDate,
  formatMoney,
  formatRate,
} from "@/lib/format";
import { cn } from "@/lib/utils";

const Arrow = () => <span className="text-muted-foreground">→</span>;
const Muted = ({ children }: { children: React.ReactNode }) => (
  <span className="text-muted-foreground">{children}</span>
);

// The queue's compact story cell: what the data expected vs what was filed,
// shaped per variance type from the alert's details payload.
function ExpectedVsFiled({ row }: { row: VarianceQueueRow }) {
  const d = row.details ?? {};
  const str = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : null);
  const numV = (k: string) => (typeof d[k] === "number" ? (d[k] as number) : null);

  switch (row.alertType) {
    case "hts_discrepancy":
      return row.catalogHts && row.declaredHts ? (
        <span className="inline-flex items-center gap-2">
          <HtsCode code={row.catalogHts} />
          <Arrow />
          <HtsCode code={row.declaredHts} compareTo={row.catalogHts} />
        </span>
      ) : (
        <Muted>catalog differs</Muted>
      );
    case "hts_reclassified":
      // Filed code (matched its day's catalog) → today's classification.
      return row.declaredHts && row.catalogHts ? (
        <span className="inline-flex items-center gap-2">
          <HtsCode code={row.declaredHts} />
          <Arrow />
          <HtsCode code={row.catalogHts} compareTo={row.declaredHts} />
        </span>
      ) : (
        <Muted>reclassified since filing</Muted>
      );
    case "coo_discrepancy": {
      const expected =
        str("expected_coo") ??
        (Array.isArray(d.expected_coos) ? d.expected_coos.join("/") : null);
      return (
        <span className="inline-flex items-center gap-2 tabular-nums">
          <span>{expected ?? "—"}</span>
          <Arrow />
          <span className="text-amber-700 dark:text-amber-400">
            {str("declared_coo") ?? "—"}
          </span>
        </span>
      );
    }
    case "rate_mismatch":
      return (
        <span className="inline-flex items-center gap-2 tabular-nums">
          <span>{formatRate(numV("expected_rate"))}</span>
          <Arrow />
          <span className="text-amber-700 dark:text-amber-400">
            {formatRate(numV("actual_rate"))}
          </span>
        </span>
      );
    case "amount_mismatch":
      return (
        <span className="inline-flex items-center gap-2 tabular-nums">
          <span>{formatMoney(numV("expected_amount"))}</span>
          <Arrow />
          <span className="text-amber-700 dark:text-amber-400">
            {formatMoney(numV("actual_amount"))}
          </span>
        </span>
      );
    case "missing_measure": {
      const name = str("measure_name") ?? "Base duty";
      return (
        <span className="inline-flex items-center gap-2">
          <span>
            {name}{" "}
            <span className="tabular-nums">{formatRate(numV("expected_rate"))}</span>
          </span>
          <Arrow />
          <Muted>not declared</Muted>
        </span>
      );
    }
    case "unexpected_measure":
      return (
        <span className="inline-flex items-center gap-2">
          <Muted>not expected</Muted>
          <Arrow />
          <span>
            {str("measure_name") ?? "measure"}{" "}
            <span className="tabular-nums">{formatMoney(numV("actual_amount"))}</span>
          </span>
        </span>
      );
    case "value_mismatch":
    case "data_unreconciled":
      return (
        <span className="inline-flex items-center gap-2 tabular-nums">
          <span>{formatMoney(numV("expected_amount"))}</span>
          <Arrow />
          <span className="text-amber-700 dark:text-amber-400">
            {formatMoney(numV("actual_amount"))}
          </span>
        </span>
      );
    case "invoice_hts_mismatch": {
      const expected = str("expected_hts");
      const actual = str("actual_hts");
      return expected && actual ? (
        <span className="inline-flex items-center gap-2">
          <HtsCode code={expected} />
          <Arrow />
          <HtsCode code={actual} compareTo={expected} />
        </span>
      ) : (
        <Muted>invoice differs</Muted>
      );
    }
    case "quantity_discrepancy":
      return (
        <span className="inline-flex items-center gap-2 tabular-nums">
          <span>{numV("expected_quantity") ?? "—"}</span>
          <Arrow />
          <span className="text-amber-700 dark:text-amber-400">
            {numV("actual_quantity") ?? "—"}
          </span>
        </span>
      );
    case "invoice_sku_missing":
      return (
        <span className="inline-flex items-center gap-2">
          <Muted>on invoice</Muted>
          <Arrow />
          <span className="text-amber-700 dark:text-amber-400">not found</span>
        </span>
      );
    case "invoice_comparison_skipped":
      return <Muted>{str("currency") ?? "non-USD"} invoice — skipped</Muted>;
    default:
      return <Muted>{row.label}</Muted>;
  }
}

function WindowCell({ row }: { row: VarianceQueueRow }) {
  const w = row.window;
  // Both short-circuits stay right-aligned so they line up with the "Window"
  // header and with the countdown rows below them.
  if (w.closed)
    return (
      <div className="text-right text-xs text-muted-foreground">Liquidated</div>
    );
  if (w.daysLeft === null)
    return (
      <div className="text-right">
        <Muted>—</Muted>
      </div>
    );
  const urgent = w.daysLeft <= 60;
  const pct = Math.max(
    0,
    Math.min(100, (w.daysLeft / LIQUIDATION_WINDOW_DAYS) * 100),
  );
  return (
    <div
      className="flex items-center justify-end gap-2"
      title={`Est. liquidation ${formatDate(w.estDate)} (entry + ${LIQUIDATION_WINDOW_DAYS}d)`}
    >
      <div className="h-1 w-16 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full",
            urgent ? "bg-amber-500" : "bg-primary/60",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span
        className={cn(
          "text-xs tabular-nums",
          urgent
            ? "text-amber-700 dark:text-amber-400"
            : "text-muted-foreground",
        )}
      >
        {w.daysLeft}d
      </span>
    </div>
  );
}

const columns: ColumnDef<VarianceQueueRow>[] = [
  {
    id: "line",
    header: "Part / line",
    cell: ({ row }) => (
      <div>
        <div className="font-medium">{row.original.sku ?? "—"}</div>
        <div className="max-w-56 truncate text-xs text-muted-foreground">
          {row.original.lineNumber !== null
            ? `line ${row.original.lineNumber}`
            : "entry-level"}
          {row.original.description ? ` · ${row.original.description}` : ""}
        </div>
      </div>
    ),
  },
  {
    id: "type",
    header: "Variance",
    cell: ({ row }) => <StatusBadge status={row.original.alertType} />,
  },
  {
    id: "diff",
    header: "Expected → filed",
    cell: ({ row }) => (
      <div className="font-medium">
        <ExpectedVsFiled row={row.original} />
      </div>
    ),
  },
  {
    id: "entry",
    header: "Entry",
    cell: ({ row }) => (
      <div>
        <Link
          href={`/entries/${row.original.entryId}`}
          className="tabular-nums hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {row.original.entryNumber}
        </Link>
        <div className="text-xs text-muted-foreground">
          filed {formatDate(row.original.entryDate)}
        </div>
      </div>
    ),
  },
  {
    id: "impact",
    header: () => <div className="text-right">Impact</div>,
    cell: ({ row }) => {
      const { impactCents, direction } = row.original;
      if (impactCents === null)
        return <div className="text-right text-muted-foreground">—</div>;
      return (
        <div
          className={cn(
            "text-right font-medium tabular-nums",
            direction === "recoverable" &&
              "text-emerald-700 dark:text-emerald-400",
            direction === "exposure" && "text-red-700 dark:text-red-400",
            direction === null && "text-muted-foreground",
          )}
        >
          {direction === "recoverable" ? "+" : direction === "exposure" ? "−" : ""}
          {formatCents(Math.abs(impactCents))}
        </div>
      );
    },
  },
  {
    id: "window",
    header: () => <div className="text-right">Window</div>,
    cell: ({ row }) => <WindowCell row={row.original} />,
  },
];

export function VarianceTable({
  rows,
  totalCount,
}: {
  rows: VarianceQueueRow[];
  /** Row count before the search filter — picks the right empty message. */
  totalCount: number;
}) {
  const router = useRouter();
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.alertId,
  });

  return (
    <div className="rounded-md border">
      <Table className="[&_td]:py-3">
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
                {totalCount === 0
                  ? "Nothing open — every entry reconciles against the catalog and reference data."
                  : "No variances match the filter."}
              </TableCell>
            </TableRow>
          ) : (
            table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                className="cursor-pointer"
                onClick={() => router.push(row.original.href)}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

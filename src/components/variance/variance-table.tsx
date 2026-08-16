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
import { fieldIssue } from "@/lib/variance/field-issue";
import type { VarianceGroup } from "@/lib/variance/grouping";
import { LIQUIDATION_WINDOW_DAYS } from "@/lib/variance/window";
import {
  formatCents,
  formatDate,
  formatMoney,
  formatRate,
} from "@/lib/format";
import { cn } from "@/lib/utils";

type QueueGroup = VarianceGroup<VarianceQueueRow>;

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
      return <Muted>{str("currency") ?? "non-USD"} invoice, skipped</Muted>;
    default:
      // AI findings: their first filed-vs-expected row renders like any
      // rule diff; a pure observation (no fields) falls back to the claim
      // with its confidence.
      if (row.alertType.startsWith("ai_")) {
        const issue = fieldIssue({ alertType: row.alertType, details: d });
        if (issue) {
          return (
            <span className="inline-flex items-center gap-2">
              <span className="tabular-nums">{issue.expected}</span>
              <Arrow />
              <span className="tabular-nums text-amber-700 dark:text-amber-400">
                {issue.filed}
              </span>
            </span>
          );
        }
        const confidence = numV("confidence");
        return (
          <span className="inline-flex max-w-md items-baseline gap-2">
            <span className="truncate font-normal">{row.message}</span>
            {confidence !== null ? (
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {Math.round(confidence * 100)}%
              </span>
            ) : null}
          </span>
        );
      }
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

// One row = one line item; its issues stack inside the Variance and diff
// cells in the group's canonical order (members[0] = worst). The badge and
// diff columns use the same fixed item height so badge N stays aligned
// with diff N.
const STACK_ITEM = "flex h-6 items-center";

// Archived rows (visible via "Show archived") hold only decided issues —
// active rows hold only open ones — so members[0] speaks for the group.
const isArchived = (g: QueueGroup) => g.members[0].status !== "open";

const columns: ColumnDef<QueueGroup>[] = [
  {
    id: "line",
    header: "Part / line",
    cell: ({ row }) => {
      const primary = row.original.members[0];
      return (
        <div>
          <div className="font-medium">{primary.sku ?? "—"}</div>
          <div className="max-w-56 truncate text-xs text-muted-foreground">
            {primary.lineNumber !== null
              ? `line ${primary.lineNumber}`
              : "entry-level"}
            {primary.description ? ` · ${primary.description}` : ""}
          </div>
        </div>
      );
    },
  },
  {
    id: "type",
    header: "Variance",
    cell: ({ row }) => (
      <div className="flex flex-col items-start gap-1.5">
        {row.original.members.map((m) => (
          <div key={m.alertId} className={cn(STACK_ITEM, "gap-1.5")}>
            <StatusBadge status={m.alertType} />
            {m.status !== "open" ? (
              <span className="text-xs text-muted-foreground">
                {m.status === "resolved" ? "accepted" : "dismissed"}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    ),
  },
  {
    id: "diff",
    header: "Expected → Filed",
    cell: ({ row }) => (
      <div className="flex flex-col gap-1.5 font-medium">
        {row.original.members.map((m) => (
          <div key={m.alertId} className={STACK_ITEM}>
            <ExpectedVsFiled row={m} />
          </div>
        ))}
      </div>
    ),
  },
  {
    id: "entry",
    header: "Entry",
    cell: ({ row }) => {
      const primary = row.original.members[0];
      return (
        <div>
          <Link
            href={`/entries/${primary.entryId}`}
            className="tabular-nums hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {primary.entryNumber}
          </Link>
          <div className="text-xs text-muted-foreground">
            filed {formatDate(primary.entryDate)}
          </div>
        </div>
      );
    },
  },
  {
    id: "impact",
    header: () => <div className="text-right">Impact</div>,
    cell: ({ row }) => {
      // Deduped group sums; both lines show when directions mix on a line.
      const { recoverableCents, exposureCents } = row.original;
      if (recoverableCents === 0 && exposureCents === 0)
        return <div className="text-right text-muted-foreground">—</div>;
      return (
        <div className="text-right font-medium tabular-nums">
          {recoverableCents > 0 ? (
            <div className="text-emerald-700 dark:text-emerald-400">
              +{formatCents(recoverableCents)}
            </div>
          ) : null}
          {exposureCents > 0 ? (
            <div
              className={cn(
                "text-red-700 dark:text-red-400",
                recoverableCents > 0 && "text-xs",
              )}
            >
              −{formatCents(exposureCents)}
            </div>
          ) : null}
        </div>
      );
    },
  },
  {
    id: "window",
    header: () => <div className="text-right">Window</div>,
    cell: ({ row }) => <WindowCell row={row.original.members[0]} />,
  },
];

export function VarianceTable({
  groups,
  totalCount,
}: {
  groups: QueueGroup[];
  /** Row count before the search filter — picks the right empty message. */
  totalCount: number;
}) {
  const router = useRouter();
  const table = useReactTable({
    data: groups,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (group) => group.id,
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
                  ? "Nothing open. Every entry reconciles."
                  : "No variances match the filter."}
              </TableCell>
            </TableRow>
          ) : (
            table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                className={cn(
                  // TableRow's default hover wash (muted/50) sits at parity
                  // with the page background in light mode; a foreground
                  // alpha registers on any surface, so the row reads as
                  // clickable. 2% matches the wash the variance ledger's
                  // linked rows get over the card — keep them in step.
                  "cursor-pointer hover:bg-foreground/2",
                  // Decided history reads as background, not work to do.
                  isArchived(row.original) && "opacity-60",
                )}
                onClick={() => router.push(row.original.href)}
                // Hover-prefetch the (force-dynamic) detail page so the
                // click lands near-instantly; per-row viewport prefetch
                // would fire dozens of full renders, mouse-enter fires one.
                onMouseEnter={() => router.prefetch(row.original.href)}
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

"use client";

import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  useReactTable,
  type ColumnDef,
  type ExpandedState,
} from "@tanstack/react-table";
import { ChevronDown, ChevronRight } from "lucide-react";

import { EditableCell } from "@/components/inline-edit";
import { PartExpansion } from "@/components/parts/part-expansion";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { PartRow } from "@/lib/db/queries/parts";
import type { PartHtsReviewStatusValue } from "@/lib/db/schema";
import { formatCents, formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

const reviewStatusMeta: Record<
  PartHtsReviewStatusValue,
  { label: string; className: string }
> = {
  pending: {
    label: "needs review",
    className:
      "border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-400",
  },
  confirmed: {
    label: "confirmed",
    className:
      "border-blue-300 text-blue-700 dark:border-blue-800 dark:text-blue-400",
  },
  accepted: {
    label: "accepted",
    className:
      "border-green-300 text-green-700 dark:border-green-800 dark:text-green-400",
  },
  acknowledged: {
    label: "acknowledged",
    className:
      "border-green-300 text-green-700 dark:border-green-800 dark:text-green-400",
  },
  rejected: {
    label: "rejected",
    className: "text-muted-foreground",
  },
};

const ESTIMATE_TITLE =
  "Unit cost + today's duty stack + nominal MPF/HMF. Freight, insurance & brokerage not included.";

// The signature Parts surface: one expandable table where each SKU row opens
// to its quote sheets and history. Same TanStack pattern as the entries
// table, including the chevron's stopPropagation before toggle — the row
// click also toggles, and without it the two handlers cancel each other.
export function PartsTable({
  parts,
  totalCount,
  initialExpandedPartId,
  onReview,
  onAddQuote,
}: {
  parts: PartRow[];
  totalCount: number;
  initialExpandedPartId: string | null;
  onReview: (partId: string) => void;
  onAddQuote: (part: PartRow) => void;
}) {
  const [expanded, setExpanded] = React.useState<ExpandedState>(() =>
    initialExpandedPartId ? { [initialExpandedPartId]: true } : {},
  );

  const columns = React.useMemo<ColumnDef<PartRow>[]>(
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
              e.stopPropagation();
              row.toggleExpanded();
            }}
            aria-label={row.getIsExpanded() ? "Collapse SKU" : "Expand SKU"}
          >
            {row.getIsExpanded() ? <ChevronDown /> : <ChevronRight />}
          </Button>
        ),
      },
      {
        accessorKey: "sku",
        header: "SKU",
        cell: ({ row }) => (
          <div className="flex items-center gap-1.5">
            <span className="font-medium">{row.original.sku}</span>
            {row.original.status === "draft" ? (
              <StatusBadge status="draft" />
            ) : null}
          </div>
        ),
      },
      {
        // The part's human-readable identity. `name` is always populated
        // (the SKU code alone identifies nothing); `description` stays an
        // expansion-level detail.
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <EditableCell
            endpoint={`/api/parts/${row.original.id}/fields`}
            field="name"
            value={row.original.name}
            placeholder="add"
          />
        ),
      },
      {
        accessorKey: "countryOfOrigin",
        header: "Origin",
        cell: ({ row }) => (
          <EditableCell
            endpoint={`/api/parts/${row.original.id}/fields`}
            field="countryOfOrigin"
            value={row.original.countryOfOrigin ?? ""}
            placeholder="add"
            className="w-fit"
          />
        ),
      },
      {
        accessorKey: "manufacturer",
        header: "Manufacturer",
        cell: ({ row }) => (
          <EditableCell
            endpoint={`/api/parts/${row.original.id}/fields`}
            field="manufacturer"
            value={row.original.manufacturer ?? ""}
            placeholder="add"
          />
        ),
      },
      {
        accessorKey: "unitCost",
        header: () => <div className="text-right">Cost/unit</div>,
        cell: ({ row }) => (
          <EditableCell
            endpoint={`/api/parts/${row.original.id}/fields`}
            field="unitCost"
            type="number"
            value={row.original.unitCost ?? ""}
            display={
              row.original.unitCost === null
                ? undefined
                : formatMoney(row.original.unitCost)
            }
            placeholder="add"
            className="text-right tabular-nums"
            inputClassName="text-right"
          />
        ),
      },
      {
        id: "hts",
        header: "HTS",
        cell: ({ row }) => {
          const part = row.original;
          return (
            <div className="flex flex-col gap-0.5">
              <span className="tabular-nums">{part.htsCode ?? "—"}</span>
              <div className="flex items-center gap-1.5">
                {part.htsCodeProvisional ? (
                  <Badge
                    variant="outline"
                    className="font-normal text-muted-foreground"
                    title="Auto-selected by the classifier; not yet human-committed. Ignored by audits."
                  >
                    provisional
                  </Badge>
                ) : null}
                {part.htsReviewStatus ? (
                  <Badge
                    variant="outline"
                    className={cn(
                      "font-normal",
                      reviewStatusMeta[part.htsReviewStatus].className,
                    )}
                  >
                    {reviewStatusMeta[part.htsReviewStatus].label}
                  </Badge>
                ) : null}
                {part.openReviewItemId ? (
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      onReview(part.id);
                    }}
                  >
                    Review
                  </Button>
                ) : null}
              </div>
            </div>
          );
        },
      },
      {
        id: "quotes",
        header: "Quotes",
        cell: ({ row }) => {
          const part = row.original;
          const total = part.quotes.length;
          if (total === 0) return null;
          return (
            <Badge
              variant="outline"
              className={cn(
                "font-normal",
                part.hasUnapproved &&
                  "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
              )}
              title={
                part.hasUnapproved
                  ? "A received quote is awaiting a decision — expand the row."
                  : part.pendingChanges
                    ? "An approved quote is waiting for its confirming PO."
                    : undefined
              }
            >
              {total} quote{total === 1 ? "" : "s"}
            </Badge>
          );
        },
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => <StatusBadge status={row.original.displayStatus} />,
      },
      {
        id: "estLanded",
        header: () => <div className="text-right">Est. landed/unit</div>,
        cell: ({ row }) => {
          const part = row.original;
          if (part.estimatedPerUnitCents === null) {
            return (
              <div className="text-right tabular-nums text-muted-foreground">
                —
              </div>
            );
          }
          const isDraft = part.status === "draft";
          return (
            <div
              className={cn(
                "text-right font-medium tabular-nums",
                isDraft && "font-normal text-muted-foreground",
              )}
              title={
                isDraft
                  ? `${ESTIMATE_TITLE} Draft SKU — inputs come from an unapproved quote.`
                  : ESTIMATE_TITLE
              }
            >
              {part.estimateIncomplete ? "≥ " : ""}
              {formatCents(part.estimatedPerUnitCents)}
            </div>
          );
        },
      },
    ],
    [onReview],
  );

  const table = useReactTable({
    data: parts,
    columns,
    state: { expanded },
    onExpandedChange: setExpanded,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getRowCanExpand: () => true,
    getRowId: (row) => row.id,
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border">
        <Table>
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
                    ? "No SKUs yet. Create one with New SKU, or ingest a quote sheet."
                    : "No parts match the filter."}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <React.Fragment key={row.id}>
                  <TableRow
                    data-state={row.getIsExpanded() ? "selected" : undefined}
                    className="cursor-pointer"
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
                        <PartExpansion
                          part={row.original}
                          onAddQuote={onAddQuote}
                        />
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        {parts.length} of {totalCount} SKUs · landed/unit is duty-inclusive
        (no freight, insurance, or brokerage)
      </p>
    </div>
  );
}

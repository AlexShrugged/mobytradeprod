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
import { ChevronDown, ChevronRight, Upload } from "lucide-react";

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
import type { CentsRange, PartRow } from "@/lib/db/queries/parts";
import { formatCents } from "@/lib/format";
import { cn } from "@/lib/utils";

/** "$42.30" when the vendors agree, "$42.30–$44.10" when they don't. */
function formatCentsRange(range: CentsRange): string {
  return range.min === range.max
    ? formatCents(range.min)
    : `${formatCents(range.min)}–${formatCents(range.max)}`;
}

const ESTIMATE_TITLE =
  "Unit cost + today's duty stack + nominal MPF/HMF. Freight, insurance & brokerage not included.";

// The signature Parts surface: one expandable table where each SKU row opens
// to its quote sheets and history. Same TanStack pattern as the entries
// table, including the chevron's stopPropagation before toggle — the row
// click also toggles, and without it the two handlers cancel each other.
export function PartsTable({
  parts,
  totalCount,
  filteredCount,
  pageStart,
  initialExpandedPartId,
  onReview,
  onAddQuote,
  onImport,
}: {
  /** The current page of rows only — filtering and paging are server-side. */
  parts: PartRow[];
  /** Org-wide SKU count — decides the getting-started empty state. */
  totalCount: number;
  /** SKUs matching the search across all pages. */
  filteredCount: number;
  /** Zero-based offset of the first row on this page. */
  pageStart: number;
  initialExpandedPartId: string | null;
  onReview: (partId: string, code?: string) => void;
  onAddQuote: (part: PartRow) => void;
  onImport: () => void;
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
        // expansion-level detail. Width-capped: imported catalogs carry
        // very long names that would otherwise stretch the whole table —
        // truncated here (full name on hover), and the edit input floats
        // over the row so the full name is editable in place.
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <EditableCell
            endpoint={`/api/parts/${row.original.id}/fields`}
            field="name"
            value={row.original.name}
            placeholder="add"
            className="max-w-96"
            expandOnEdit
          />
        ),
      },
      {
        // The (vendor, origin) sourcing summary — per-vendor detail and
        // editing live in the expansion's Sources card.
        id: "sourcing",
        header: "Sourcing",
        cell: ({ row }) => {
          const sources = row.original.sources;
          if (sources.length === 0) {
            return <span className="text-muted-foreground">—</span>;
          }
          const origins = [
            ...new Set(
              sources
                .map((s) => s.countryOfOrigin)
                .filter((c): c is string => c !== null),
            ),
          ];
          const originLabel = origins.length > 0 ? origins.join(", ") : "—";
          const detail = sources
            .map((s) => `${s.vendorName} · ${s.countryOfOrigin ?? "no origin"}`)
            .join("\n");
          if (sources.length === 1) {
            return (
              <span title={detail}>
                {sources[0].vendorName}
                <span className="text-muted-foreground"> · {originLabel}</span>
              </span>
            );
          }
          return (
            <span title={detail}>
              {sources.length} vendors
              <span className="text-muted-foreground"> · {originLabel}</span>
            </span>
          );
        },
      },
      {
        id: "unitCost",
        header: () => <div className="text-right">Cost/unit</div>,
        cell: ({ row }) => {
          const range = row.original.costRangeCents;
          if (range === null) {
            return (
              <div className="text-right tabular-nums text-muted-foreground">
                —
              </div>
            );
          }
          return (
            <div
              className="text-right tabular-nums"
              title={
                range.min === range.max
                  ? undefined
                  : "Vendors quote different costs. Expand for per-vendor detail."
              }
            >
              {formatCentsRange(range)}
            </div>
          );
        },
      },
      {
        // Just the code — review state and actions live in the expansion's
        // Classification card, not as table pills.
        id: "hts",
        header: "HTS",
        cell: ({ row }) => (
          <span className="tabular-nums">{row.original.htsCode ?? "—"}</span>
        ),
      },
      {
        id: "quotes",
        header: "Quotes",
        cell: ({ row }) => {
          const part = row.original;
          const total = part.quotes.length;
          if (total === 0 && part.reconsider === null) return null;
          // The words carry the state, not the tint: undecided quotes read
          // "N to decide" (amber), otherwise the plain count. An approved
          // quote waiting on its PO already shows as the Status column's
          // "Pending changes".
          const toDecide = part.quoteCounts.received;
          return (
            <div className="flex items-center gap-1.5">
              {toDecide > 0 ? (
                <Badge
                  variant="outline"
                  className="border-amber-500/30 bg-amber-500/10 font-normal text-amber-700 dark:text-amber-400"
                >
                  {toDecide} to decide
                </Badge>
              ) : total > 0 ? (
                <Badge variant="outline" className="font-normal">
                  {total} quote{total === 1 ? "" : "s"}
                </Badge>
              ) : null}
              {part.reconsider ? (
                <span
                  title={`${part.reconsider.proposal.cheapest.label} now cheapest after ${part.reconsider.proposal.changeLabel}.`}
                >
                  <StatusBadge status="reconsider" />
                </span>
              ) : null}
            </div>
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
          const range = part.estimatedRangeCents;
          if (range === null) {
            return (
              <div className="text-right tabular-nums text-muted-foreground">
                —
              </div>
            );
          }
          const isDraft = part.status === "draft";
          const spread =
            range.min !== range.max
              ? " The spread is per-vendor: origin decides which measures apply."
              : "";
          const basis =
            part.comparison.basis.kind === "committed"
              ? ""
              : ` Priced under a ${part.comparison.basis.kind} HTS code (${part.comparison.basis.code}).`;
          return (
            <div
              className={cn(
                "text-right font-medium tabular-nums",
                (isDraft || basis !== "") && "font-normal text-muted-foreground",
              )}
              title={
                isDraft
                  ? `${ESTIMATE_TITLE}${spread}${basis} Draft SKU: inputs from an unapproved quote.`
                  : `${ESTIMATE_TITLE}${spread}${basis}`
              }
            >
              {part.estimateIncomplete ? "≥ " : ""}
              {formatCentsRange(range)}
            </div>
          );
        },
      },
    ],
    [],
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
              <TableRow className="hover:bg-transparent">
                {totalCount === 0 ? (
                  // The getting-started empty state: most catalogs arrive as
                  // a whole SKU list, so importing leads.
                  <TableCell colSpan={columns.length} className="h-48">
                    <div className="flex justify-center">
                      <Button variant="outline" onClick={onImport}>
                        <Upload /> Import Parts
                      </Button>
                    </div>
                  </TableCell>
                ) : (
                  <TableCell
                    colSpan={columns.length}
                    className="h-24 text-center text-muted-foreground"
                  >
                    No parts match the filter.
                  </TableCell>
                )}
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <React.Fragment key={row.id}>
                  <TableRow
                    data-state={row.getIsExpanded() ? "selected" : undefined}
                    // TableRow's default hover wash (muted/50) sits at parity
                    // with the page background in light mode; a foreground
                    // alpha registers on any surface, so the row reads as
                    // clickable. 2% matches the wash the variance ledger's
                    // linked rows get over the card — keep them in step.
                    className="cursor-pointer hover:bg-foreground/2"
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
                          onReview={onReview}
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
        {parts.length === 0
          ? `0 of ${filteredCount} SKUs`
          : `${pageStart + 1}–${pageStart + parts.length} of ${filteredCount} SKUs`}
      </p>
    </div>
  );
}

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
import { ChevronDown, ChevronRight, FileText, Ship } from "lucide-react";

import { AuditBadge } from "@/components/entries/audit-badge";
import { DutiesPopover } from "@/components/entries/duties-popover";
import { Money } from "@/components/money";
import { SailDateCell } from "@/components/sail-basis";
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
import type {
  EntryRow,
  FutureEntryRow,
} from "@/lib/db/queries/entries";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

// The list is a union: real entries plus the derived future-entry
// projection (kind discriminant). Future rows render first, visually
// distinct (amber tint, dashed left edge, ~estimated money), and expand
// exactly like entries — both kinds carry the same shipments/POs payload.
export type EntriesTableRow = EntryRow | FutureEntryRow;

const cents = (v: string | null): number | null =>
  v === null ? null : Math.round(Number(v) * 100);

/** The savings-clause chip text — also the hover title. */
function deadlineNoteFor(row: FutureEntryRow): string | null {
  if (!row.deadline) return null;
  return `${row.deadline.measureName}: duty-free only if entered by ${formatDate(row.deadline.enteredBy)}`;
}

function DutiesFeesCell({ row }: { row: EntriesTableRow }) {
  if (row.kind === "future") {
    return (
      <div className="text-right">
        <DutiesPopover
          total={row.estimatedDutiesCents}
          base={row.estimatedBaseDutyCents}
          additional={row.estimatedAdditionalDutiesCents}
          mpf={row.estimatedMpfCents}
          hmf={row.estimatedHmfCents}
          estimate
          sailBasis={row.sailBasis === "exact" ? null : row.sailBasis}
          deadlineNote={deadlineNoteFor(row)}
        />
      </div>
    );
  }
  const duty = cents(row.totalDuty);
  const base = cents(row.totalBaseDuty);
  return (
    <div className="text-right">
      <DutiesPopover
        total={cents(row.dutiesAndFeesTotal)}
        base={base}
        additional={duty !== null && base !== null ? duty - base : null}
        mpf={cents(row.mpfAmount)}
        hmf={cents(row.hmfAmount)}
      />
    </div>
  );
}

// Per-column gutter overrides, applied to both the header and the body cell so
// they stay aligned. Duties & fees is right-aligned and Refund is left-aligned,
// so at the default p-2 the two columns' contents collide at the boundary with
// 16px between them while every other neighbour pair gets far more.
const COLUMN_CLASS: Record<string, string> = {
  refund: "px-6",
};

// Column defs are additive on purpose: future customs columns slot in here
// without touching the expansion UI.
const columns: ColumnDef<EntriesTableRow>[] = [
  {
    id: "expander",
    header: () => null,
    cell: ({ row }) =>
      row.getCanExpand() ? (
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
          aria-label={row.getIsExpanded() ? "Collapse entry" : "Expand entry"}
        >
          {row.getIsExpanded() ? <ChevronDown /> : <ChevronRight />}
        </Button>
      ) : null,
  },
  {
    id: "entryNumber",
    header: "Entry #",
    cell: ({ row }) =>
      row.original.kind === "future" ? (
        <div className="flex flex-col">
          <span className="font-medium">{row.original.shipmentNumber}</span>
          <span className="text-xs text-amber-700 dark:text-amber-400">
            Future entry
          </span>
        </div>
      ) : (
        <Link
          href={`/entries/${row.original.id}`}
          className="font-medium hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {row.original.entryNumber}
        </Link>
      ),
  },
  {
    id: "entryDate",
    header: "Entry date",
    cell: ({ row }) =>
      row.original.kind === "future" ? (
        row.original.projectedEntryDate ? (
          <span
            className="text-muted-foreground"
            title="Projected from the shipment's ETA; no entry filed yet"
          >
            ~{formatDate(row.original.projectedEntryDate)}
          </span>
        ) : (
          "—"
        )
      ) : (
        formatDate(row.original.entryDate)
      ),
  },
  {
    id: "portOfEntry",
    header: "Port of entry",
    cell: ({ row }) =>
      row.original.kind === "future" ? (
        <span className="text-muted-foreground">
          {row.original.portOfEntry ?? "—"}
        </span>
      ) : (
        (row.original.portOfEntry ?? "—")
      ),
  },
  {
    id: "status",
    header: "Status",
    cell: ({ row }) => (
      <StatusBadge
        status={row.original.kind === "future" ? "projected" : row.original.status}
      />
    ),
  },
  {
    id: "shipments",
    header: "Shipments",
    cell: ({ row }) => (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Ship className="size-3.5" /> {row.original.shipments.length}
      </span>
    ),
  },
  {
    id: "purchaseOrders",
    header: "POs",
    cell: ({ row }) => (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <FileText className="size-3.5" /> {row.original.purchaseOrders.length}
      </span>
    ),
  },
  {
    id: "enteredValue",
    header: () => <div className="text-right">Entered value</div>,
    cell: ({ row }) => (
      <div className="text-right">
        {row.original.kind === "future" ? (
          <Money cents={row.original.estimatedEnteredValueCents} estimate />
        ) : (
          <Money value={row.original.totalEnteredValue} />
        )}
      </div>
    ),
  },
  {
    id: "dutiesAndFees",
    header: () => <div className="text-right">Duties &amp; fees</div>,
    cell: ({ row }) => <DutiesFeesCell row={row.original} />,
  },
  {
    id: "refund",
    // Left-aligned, unlike the two money columns before it: the stage pill
    // trails the amount, so right-aligning would ragged the numbers and crowd
    // the audit column next door.
    header: "Refund",
    cell: ({ row }) => {
      if (row.original.kind === "future" || row.original.totalRefund === null) {
        return <span className="tabular-nums text-muted-foreground">—</span>;
      }
      return (
        <div className="flex items-center gap-2 whitespace-nowrap">
          <Money value={row.original.totalRefund} tone="refund" />
          {row.original.refundStage ? (
            <StatusBadge status={row.original.refundStage} />
          ) : null}
        </div>
      );
    },
  },
  {
    id: "audit",
    header: "Audit",
    cell: ({ row }) =>
      row.original.kind === "future" ? (
        // Nothing declared yet — nothing to audit.
        <span className="text-muted-foreground">—</span>
      ) : (
        <AuditBadge
          counts={row.original.openAlerts}
          hasData={row.original.lineItemCount > 0}
        />
      ),
  },
];

function ExpandedEntry({ entry }: { entry: EntriesTableRow }) {
  return (
    <div className="flex flex-col gap-4 bg-muted/30 px-12 py-4">
      <div>
        <h4 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
          <Ship className="size-4" /> Shipments
        </h4>
        {entry.shipments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No shipments linked to this entry.
          </p>
        ) : (
          <div className="rounded-md border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Shipment #</TableHead>
                  <TableHead>BOL / AWB</TableHead>
                  <TableHead>Container</TableHead>
                  <TableHead>Carrier</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead>Sailed</TableHead>
                  <TableHead>ETA</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>POs on board</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entry.shipments.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">
                      {s.shipmentNumber}
                    </TableCell>
                    <TableCell>{s.billOfLading ?? "—"}</TableCell>
                    <TableCell>{s.containerNumber ?? "—"}</TableCell>
                    <TableCell>{s.carrier ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {s.originPort} → {s.destinationPort}
                    </TableCell>
                    <TableCell>
                      <SailDateCell
                        sailedOnBoardDate={s.sailedOnBoardDate}
                        etd={s.etd}
                      />
                    </TableCell>
                    <TableCell>{formatDate(s.eta)}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <StatusBadge status={s.status} />
                        {s.tariffFlag ? (
                          <Badge
                            className="bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
                            title={
                              s.tariffFlag.deadline
                                ? `${s.tariffFlag.measureName}: spared only if entered by ${formatDate(s.tariffFlag.deadline)}`
                                : `${s.tariffFlag.measureName} applies to this shipment`
                            }
                          >
                            tariff change
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {s.poNumbers.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          s.poNumbers.map((po) => (
                            <Badge
                              key={po}
                              variant="outline"
                              className="font-normal"
                            >
                              {po}
                            </Badge>
                          ))
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <div>
        <h4 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
          <FileText className="size-4" /> Purchase orders
        </h4>
        {entry.purchaseOrders.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No purchase orders linked to this entry.
          </p>
        ) : (
          <div className="rounded-md border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>PO #</TableHead>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Order date</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entry.purchaseOrders.map((po) => (
                  <TableRow key={po.id}>
                    <TableCell className="font-medium">{po.poNumber}</TableCell>
                    <TableCell>{po.supplierName ?? "—"}</TableCell>
                    <TableCell>{formatDate(po.orderDate)}</TableCell>
                    <TableCell className="text-right">
                      <Money value={po.totalAmount} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}

export function EntriesTable({ rows }: { rows: EntriesTableRow[] }) {
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getRowCanExpand: () => true,
    getRowId: (row) => row.id,
  });

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead
                  key={header.id}
                  className={COLUMN_CLASS[header.column.id]}
                >
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
                No entries yet. Process port entry documents on the Data
                page to create them.
              </TableCell>
            </TableRow>
          ) : (
            table.getRowModel().rows.map((row) => (
              <React.Fragment key={row.id}>
                <TableRow
                  data-state={row.getIsExpanded() ? "selected" : undefined}
                  className={cn(
                    // TableRow's default hover wash (muted/50) sits at parity
                    // with the page background in light mode; a foreground
                    // alpha registers on any surface, so the row reads as
                    // clickable. 2% matches the wash the variance ledger's
                    // linked rows get over the card — keep them in step.
                    "cursor-pointer hover:bg-foreground/2",
                    // Projection rows: amber tint + dashed amber left edge,
                    // so estimated rows never read as filed entries. Hover
                    // deepens the tint (same cue, kept in the row's color).
                    row.original.kind === "future" &&
                      "bg-amber-500/5 hover:bg-amber-500/10 border-l-2 border-l-amber-500/60 [border-left-style:dashed]",
                  )}
                  onClick={row.getToggleExpandedHandler()}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={COLUMN_CLASS[cell.column.id]}
                    >
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
                      <ExpandedEntry entry={row.original} />
                    </TableCell>
                  </TableRow>
                )}
              </React.Fragment>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

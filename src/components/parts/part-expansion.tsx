"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Factory,
  History,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { EditableCell } from "@/components/inline-edit";
import { eventMeta } from "@/components/events/event-meta";
import { Money } from "@/components/money";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  PartQuoteRow,
  PartRow,
  PartSourceRow,
  PartVendorUsage,
} from "@/lib/db/queries/parts";
import type { BusinessEvent } from "@/lib/events/types";
import { formatCents, formatDate } from "@/lib/format";
import {
  groupPartVendors,
  type PartVendorGroup,
} from "@/lib/vendors/part-vendor-groups";
import { cn } from "@/lib/utils";

// The row expansion: one unified vendors panel on the left (~5/12) — vendors
// with real activity first, an expandable archive of offer-only vendors
// under them — and SKU history on the right (~7/12), stacked on narrow
// screens. Same muted panel treatment as the entries expansion.
export function PartExpansion({
  part,
  onAddQuote,
}: {
  part: PartRow;
  onAddQuote: (part: PartRow) => void;
}) {
  return (
    <div className="grid gap-4 bg-muted/30 px-12 py-4 lg:grid-cols-12">
      <div className="flex flex-col gap-4 lg:col-span-5">
        <VendorsCard part={part} onAddQuote={onAddQuote} />
      </div>
      <div className="lg:col-span-7">
        <HistoryCard part={part} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- vendors

// The unified vendor panel: every vendor of this SKU with its sourcing facts
// (origin & cost edit inline — the catalog write path) and its offers (quote
// lines) nested beneath it. Vendors with real activity behind them — POs,
// invoices, entries — rank first at full detail; everyone else condenses
// into the expandable quote archive below, cost/unit and est. landed first.
function VendorsCard({
  part,
  onAddQuote,
}: {
  part: PartRow;
  onAddQuote: (part: PartRow) => void;
}) {
  const router = useRouter();
  const [removingId, setRemovingId] = React.useState<string | null>(null);
  const [busyQuoteId, setBusyQuoteId] = React.useState<string | null>(null);
  const [, startTransition] = React.useTransition();

  const { used, archive } = React.useMemo(
    () => groupPartVendors(part.sources, part.quotes),
    [part.sources, part.quotes],
  );
  const archivedReceived = archive.reduce(
    (n, g) => n + g.quotes.filter((q) => q.status === "received").length,
    0,
  );
  // A quote awaiting a decision must not hide behind a collapsed archive.
  const [archiveOpen, setArchiveOpen] = React.useState(archivedReceived > 0);

  async function removeSource(source: PartSourceRow) {
    setRemovingId(source.id);
    try {
      const res = await fetch(`/api/parts/${part.id}/sources/${source.id}`, {
        method: "DELETE",
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error ?? "Could not remove the source.");
      toast.success(`${source.vendorName} removed as a source for ${part.sku}.`);
      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not remove the source.",
      );
    } finally {
      setRemovingId(null);
    }
  }

  function decide(quote: PartQuoteRow, action: "approve" | "reject") {
    setBusyQuoteId(quote.id);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/quote-lines/${quote.id}/decide`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // No decidedBy: the server records the org's default actor.
          body: JSON.stringify({ action }),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok) throw new Error(payload?.error ?? "The decision failed.");
        if (action === "reject") {
          toast.success(`Quote rejected for ${part.sku}.`);
        } else if (payload?.line?.status === "applied") {
          // Approving a draft part's quote finalizes the SKU immediately.
          toast.success(`${part.sku} finalized at the quoted cost.`);
        } else {
          toast.success(
            `Quote approved for ${part.sku}. Applies when a matching PO arrives.`,
          );
        }
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "The decision failed.");
      } finally {
        setBusyQuoteId(null);
      }
    });
  }

  const groupProps = {
    part,
    removingId,
    onRemove: removeSource,
    busyQuoteId,
    onDecide: decide,
  };

  return (
    <div className="rounded-md border bg-background">
      <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
        <h4 className="flex items-center gap-1.5 text-sm font-medium">
          <Factory className="size-4" /> Vendors
        </h4>
        <span
          className="text-xs text-muted-foreground"
          title="Latest per-unit landed cost on a filed entry carrying this SKU"
        >
          Last actual <Money cents={part.actualLatestPerUnitCents} />
        </span>
      </div>

      {used.length === 0 && archive.length === 0 ? (
        <p className="px-3 py-4 text-sm text-muted-foreground">
          No vendors yet. Add one or record a quote.
        </p>
      ) : (
        <>
          <div className="divide-y">
            {used.map((group) => (
              <VendorGroupSection key={group.key} group={group} {...groupProps} />
            ))}
          </div>

          {archive.length > 0 ? (
            <div className={cn(used.length > 0 && "border-t")}>
              <button
                type="button"
                className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted/50"
                onClick={(e) => {
                  e.stopPropagation();
                  setArchiveOpen((o) => !o);
                }}
              >
                {archiveOpen ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
                Quote archive · {archive.length} other vendor
                {archive.length === 1 ? "" : "s"}
                {archivedReceived > 0 ? (
                  <span className="text-amber-700 dark:text-amber-400">
                    · {archivedReceived} awaiting decision
                  </span>
                ) : null}
              </button>
              {archiveOpen ? (
                <div className="divide-y border-t">
                  {archive.map((group) => (
                    <VendorGroupSection
                      key={group.key}
                      group={group}
                      condensed
                      {...groupProps}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      <AddVendorFooter part={part} onAddQuote={onAddQuote} />
    </div>
  );
}

/** "3 entries · 2 POs · 1 invoice" — why this vendor ranks as used. */
function UsageChips({ usage }: { usage: PartVendorUsage }) {
  const chips = [
    usage.entryCount > 0
      ? `${usage.entryCount} entr${usage.entryCount === 1 ? "y" : "ies"}`
      : null,
    usage.poCount > 0 ? `${usage.poCount} PO${usage.poCount === 1 ? "" : "s"}` : null,
    usage.invoiceCount > 0
      ? `${usage.invoiceCount} invoice${usage.invoiceCount === 1 ? "" : "s"}`
      : null,
  ].filter((c): c is string => c !== null);
  if (chips.length === 0) return null;
  return (
    <span className="text-xs text-muted-foreground">{chips.join(" · ")}</span>
  );
}

// One vendor's block: name + usage, the editable sourcing facts when a
// (part, vendor) source row exists, and the vendor's offers beneath.
// Condensed (archive) rows drop the usage chips — archive vendors have none.
function VendorGroupSection({
  part,
  group,
  condensed = false,
  removingId,
  onRemove,
  busyQuoteId,
  onDecide,
}: {
  part: PartRow;
  group: PartVendorGroup<PartSourceRow, PartQuoteRow>;
  condensed?: boolean;
  removingId: string | null;
  onRemove: (source: PartSourceRow) => void;
  busyQuoteId: string | null;
  onDecide: (quote: PartQuoteRow, action: "approve" | "reject") => void;
}) {
  const s = group.source;
  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-2 truncate">
          <span className="text-sm font-medium">
            {group.vendorName ?? "Unknown supplier"}
          </span>
          {!condensed && s ? <UsageChips usage={s.usage} /> : null}
        </span>
        {s ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground"
            title={`Remove ${s.vendorName} as a source`}
            disabled={removingId === s.id}
            onClick={(e) => {
              e.stopPropagation();
              onRemove(s);
            }}
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
      </div>

      {s ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="flex items-center gap-1 text-muted-foreground">
            Origin
            <EditableCell
              endpoint={`/api/parts/${part.id}/sources/${s.id}`}
              field="countryOfOrigin"
              value={s.countryOfOrigin ?? ""}
              placeholder="add"
              className="w-fit text-foreground"
            />
          </span>
          <span className="flex items-center gap-1 text-muted-foreground">
            Cost
            <EditableCell
              endpoint={`/api/parts/${part.id}/sources/${s.id}`}
              field="unitCost"
              type="number"
              value={s.unitCost ?? ""}
              display={
                s.unitCost === null ? undefined : formatCents(centsOf(s.unitCost))
              }
              placeholder="add"
              className="tabular-nums text-foreground"
            />
          </span>
          <span
            className="flex items-center gap-1 text-muted-foreground"
            title="Unit cost + today's duty stack for this vendor's origin + nominal MPF/HMF"
          >
            Landed {s.estimateIncomplete ? "≥ " : ""}
            <Money cents={s.estimatedPerUnitCents} estimate />
          </span>
        </div>
      ) : null}

      {group.quotes.length > 0 ? (
        <div className="ml-1 flex flex-col gap-1 border-l pl-2.5">
          {group.quotes.map((q) => (
            <OfferRow
              key={q.id}
              quote={q}
              showSupplier={group.vendorId === null}
              busy={busyQuoteId === q.id}
              onDecide={onDecide}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AddVendorFooter({
  part,
  onAddQuote,
}: {
  part: PartRow;
  onAddQuote: (part: PartRow) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [vendorName, setVendorName] = React.useState("");
  const [coo, setCoo] = React.useState("");
  const [cost, setCost] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [vendorNames, setVendorNames] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/vendors")
      .then(async (res) => {
        if (!res.ok) return;
        const payload = (await res.json()) as { vendors: { name: string }[] };
        if (!cancelled) setVendorNames(payload.vendors.map((v) => v.name));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function submit() {
    setBusy(true);
    try {
      const res = await fetch(`/api/parts/${part.id}/sources`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendorName,
          countryOfOrigin: coo.trim() || null,
          unitCost: cost.trim() === "" ? null : Number(cost),
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error ?? "Could not add the vendor.");
      toast.success(`${vendorName.trim()} added as a source for ${part.sku}.`);
      setOpen(false);
      setVendorName("");
      setCoo("");
      setCost("");
      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not add the vendor.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="flex items-center gap-1.5 border-t px-3 py-2">
        <Button
          variant="outline"
          size="xs"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
        >
          Add vendor
        </Button>
        <Button
          variant="outline"
          size="xs"
          onClick={(e) => {
            e.stopPropagation();
            onAddQuote(part);
          }}
        >
          Add quote
        </Button>
      </div>
    );
  }

  const datalistId = `vendors-${part.id}`;
  return (
    <div
      className="flex flex-wrap items-end gap-2 border-t px-3 py-2"
      onClick={(e) => e.stopPropagation()}
    >
      <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-muted-foreground">
        Vendor
        <Input
          list={datalistId}
          value={vendorName}
          onChange={(e) => setVendorName(e.target.value)}
          placeholder="Vendor name"
          className="h-7 text-sm"
          autoFocus
        />
        <datalist id={datalistId}>
          {vendorNames.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </label>
      <label className="flex w-16 flex-col gap-1 text-xs text-muted-foreground">
        Origin
        <Input
          value={coo}
          onChange={(e) => setCoo(e.target.value)}
          placeholder="CN"
          maxLength={2}
          className="h-7 text-sm"
        />
      </label>
      <label className="flex w-24 flex-col gap-1 text-xs text-muted-foreground">
        Cost/unit
        <Input
          type="number"
          min="0"
          step="0.01"
          value={cost}
          onChange={(e) => setCost(e.target.value)}
          placeholder="0.00"
          className="h-7 text-sm"
        />
      </label>
      <div className="flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="xs"
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
        <Button
          size="xs"
          disabled={busy || vendorName.trim() === ""}
          onClick={() => void submit()}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- offers

// quote_line statuses render through the shared tone map; "received" and
// "rejected" collide with PO/review labels there, so they alias.
const quoteBadgeStatus: Record<PartQuoteRow["status"], string> = {
  received: "quote_received",
  approved: "approved",
  applied: "applied",
  rejected: "rejected",
  superseded: "superseded",
};

// One offer under its vendor: date first (the vendor names the block above),
// then the two numbers that matter — cost/unit and est. landed under today's
// measures — then the delta vs the vendor's current official cost.
function OfferRow({
  quote,
  showSupplier,
  busy,
  onDecide,
}: {
  quote: PartQuoteRow;
  /** Unattributed offers have no vendor block naming them. */
  showSupplier: boolean;
  busy: boolean;
  onDecide: (quote: PartQuoteRow, action: "approve" | "reject") => void;
}) {
  const delta = quote.deltaVsCurrentCents;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="text-xs text-muted-foreground">
          {showSupplier ? `${quote.supplierName ?? "Unknown supplier"} · ` : ""}
          {formatDate(quote.quoteDate)}
        </span>
        <span className="tabular-nums">
          {formatCents(centsOf(quote.unitCost))}/unit
        </span>
        <span
          title="Quote cost + today's duty stack under the part's HTS + nominal MPF/HMF"
          className="flex items-center gap-1 text-muted-foreground"
        >
          Landed {quote.estimateIncomplete ? "≥ " : ""}
          <Money cents={quote.estimatedPerUnitCents} estimate />
        </span>
        {delta !== null && delta !== 0 ? (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 text-xs tabular-nums",
              delta < 0
                ? "text-emerald-700 dark:text-emerald-400"
                : "text-red-700 dark:text-red-400",
            )}
            title="Quote cost vs this vendor's current official cost/unit"
          >
            {delta < 0 ? (
              <ArrowDown className="size-3" />
            ) : (
              <ArrowUp className="size-3" />
            )}
            {formatCents(Math.abs(delta))}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5">
          {quote.status === "received" ? (
            <>
              <Button
                variant="outline"
                size="xs"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  onDecide(quote, "reject");
                }}
              >
                Reject
              </Button>
              <Button
                size="xs"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  onDecide(quote, "approve");
                }}
              >
                Approve
              </Button>
            </>
          ) : (
            <StatusBadge status={quoteBadgeStatus[quote.status]} />
          )}
        </span>
      </div>

      {quote.status === "approved" && quote.newerReceivedExists ? (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          A newer quote has been received for this SKU.
        </p>
      ) : null}
      {quote.htsCode ? (
        <p className="text-xs text-muted-foreground">
          Supplier HTS {quote.htsCode} (reference only)
        </p>
      ) : null}
    </div>
  );
}

const centsOf = (v: string): number => Math.round(Number(v) * 100);

// ---------------------------------------------------------------- history

type HistoryState =
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "ready"; events: BusinessEvent[] };

function HistoryCard({ part }: { part: PartRow }) {
  // Lazily fetched on first expand (this component only mounts then) — the
  // page payload never carries N parts × events for rows nobody opens.
  const [state, setState] = React.useState<HistoryState>({ phase: "loading" });

  React.useEffect(() => {
    let cancelled = false;
    fetch(`/api/parts/${part.id}/events`)
      .then(async (res) => {
        if (!res.ok) throw new Error();
        const payload = (await res.json()) as { events: BusinessEvent[] };
        if (!cancelled) setState({ phase: "ready", events: payload.events });
      })
      .catch(() => {
        if (!cancelled) setState({ phase: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [part.id]);

  return (
    <div className="rounded-md border bg-background">
      <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
        <h4 className="flex items-center gap-1.5 text-sm font-medium">
          <History className="size-4" /> History
        </h4>
        <Link
          href={`/events?sku=${part.id}`}
          className="text-xs text-muted-foreground hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          View all in Events →
        </Link>
      </div>

      {state.phase === "loading" ? (
        <div className="flex flex-col gap-2.5 px-3 py-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-2.5">
              <Skeleton className="size-6 rounded-full" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      ) : state.phase === "error" ? (
        <p className="px-3 py-4 text-sm text-muted-foreground">
          The history could not be loaded. Refresh to retry.
        </p>
      ) : state.events.length === 0 ? (
        <p className="px-3 py-4 text-sm text-muted-foreground">
          No history yet for this SKU.
        </p>
      ) : (
        <div className="divide-y">
          {state.events.map((event) => {
            const meta = eventMeta[event.type];
            const Icon = meta.icon;
            return (
              <div
                key={event.id}
                className="flex items-center gap-2.5 px-3 py-2"
              >
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full",
                    meta.ringClass,
                  )}
                  title={meta.label}
                >
                  <Icon className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{event.title}</div>
                  {event.detail ? (
                    <div className="truncate text-xs text-muted-foreground">
                      {event.detail}
                    </div>
                  ) : null}
                </div>
                <span
                  className="shrink-0 text-xs tabular-nums text-muted-foreground"
                  title={
                    event.dateBasis === "exact"
                      ? undefined
                      : event.dateBasis === "estimated"
                        ? "Estimated date"
                        : "Recorded date (no business date on source)"
                  }
                >
                  {event.dateBasis === "exact" ? "" : "~"}
                  {formatDate(event.occurredOn)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

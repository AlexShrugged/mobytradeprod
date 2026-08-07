"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  Factory,
  History,
  ReceiptText,
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
import type { PartQuoteRow, PartRow, PartSourceRow } from "@/lib/db/queries/parts";
import type { BusinessEvent } from "@/lib/events/types";
import { formatCents, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

// The row expansion: vendor sources stacked over quote sheets on the left
// (~5/12), SKU history on the right (~7/12), stacked on narrow screens.
// Same muted panel treatment as the entries expansion.
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
        <SourcesCard part={part} />
        <QuoteSheetsCard part={part} onAddQuote={onAddQuote} />
      </div>
      <div className="lg:col-span-7">
        <HistoryCard part={part} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- sources

// The (part, vendor) sourcing facts: who supplies this SKU, from where, at
// what cost — and what a unit lands at from each of them. Cost and COO edit
// inline (the catalog write path); vendors themselves come from documents
// or the add form below.
function SourcesCard({ part }: { part: PartRow }) {
  const router = useRouter();
  const [removingId, setRemovingId] = React.useState<string | null>(null);

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

  return (
    <div className="rounded-md border bg-background">
      <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
        <h4 className="flex items-center gap-1.5 text-sm font-medium">
          <Factory className="size-4" /> Vendor sources
        </h4>
        <span className="text-xs text-muted-foreground">
          origin &amp; cost are per vendor
        </span>
      </div>

      {part.sources.length === 0 ? (
        <p className="px-3 py-4 text-sm text-muted-foreground">
          No vendor sources yet. Origin and cost live on the vendor — add one
          below or ingest a quote.
        </p>
      ) : (
        <div className="divide-y">
          {part.sources.map((s) => (
            <div key={s.id} className="flex flex-col gap-1 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-medium">
                  {s.vendorName}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground"
                  title={`Remove ${s.vendorName} as a source`}
                  disabled={removingId === s.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeSource(s);
                  }}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
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
                      s.unitCost === null
                        ? undefined
                        : formatCents(centsOf(s.unitCost))
                    }
                    placeholder="add"
                    className="tabular-nums text-foreground"
                  />
                </span>
                <span
                  className="text-muted-foreground"
                  title="Unit cost + today's duty stack for this vendor's origin + nominal MPF/HMF."
                >
                  landed {s.estimateIncomplete ? "≥ " : ""}
                  <Money cents={s.estimatedPerUnitCents} estimate />
                </span>
                {s.quoteCounts.received +
                  s.quoteCounts.approved +
                  s.quoteCounts.applied >
                0 ? (
                  <span className="ml-auto text-xs text-muted-foreground">
                    {s.quoteCounts.received +
                      s.quoteCounts.approved +
                      s.quoteCounts.applied}{" "}
                    quote
                    {s.quoteCounts.received +
                      s.quoteCounts.approved +
                      s.quoteCounts.applied ===
                    1
                      ? ""
                      : "s"}
                  </span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

      <AddSourceForm part={part} />
    </div>
  );
}

function AddSourceForm({ part }: { part: PartRow }) {
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
      <div className="border-t px-3 py-2">
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

// ---------------------------------------------------------------- quotes

// quote_line statuses render through the shared tone map; "received" and
// "rejected" collide with PO/review labels there, so they alias.
const quoteBadgeStatus: Record<PartQuoteRow["status"], string> = {
  received: "quote_received",
  approved: "approved",
  applied: "applied",
  rejected: "rejected",
  superseded: "superseded",
};

function QuoteSheetsCard({
  part,
  onAddQuote,
}: {
  part: PartRow;
  onAddQuote: (part: PartRow) => void;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [, startTransition] = React.useTransition();

  function decide(quote: PartQuoteRow, action: "approve" | "reject") {
    setBusyId(quote.id);
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
          toast.success(`${part.sku} finalized — the quote cost is now official.`);
        } else {
          toast.success(
            `Quote approved for ${part.sku} — waiting for a matching PO.`,
          );
        }
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "The decision failed.");
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <div className="rounded-md border bg-background">
      <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
        <h4 className="flex items-center gap-1.5 text-sm font-medium">
          <ReceiptText className="size-4" /> Quote sheets
        </h4>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span title="Latest per-unit landed cost on a filed entry carrying this SKU">
            Last actual <Money cents={part.actualLatestPerUnitCents} />
          </span>
        </div>
      </div>

      {part.quotes.length === 0 ? (
        <p className="px-3 py-4 text-sm text-muted-foreground">
          No quotes for this SKU. Add one to compare landed cost.
        </p>
      ) : (
        <div className="divide-y">
          {part.quotes.map((q) => (
            <QuoteLineRow
              key={q.id}
              quote={q}
              busy={busyId === q.id}
              onDecide={decide}
            />
          ))}
        </div>
      )}

      <div className="border-t px-3 py-2">
        <Button variant="outline" size="xs" onClick={() => onAddQuote(part)}>
          Add quote
        </Button>
      </div>
    </div>
  );
}

function QuoteLineRow({
  quote,
  busy,
  onDecide,
}: {
  quote: PartQuoteRow;
  busy: boolean;
  onDecide: (quote: PartQuoteRow, action: "approve" | "reject") => void;
}) {
  const delta = quote.deltaVsCurrentCents;
  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 truncate text-sm">
          <span className="font-medium">
            {quote.supplierName ?? "Unknown supplier"}
          </span>{" "}
          <span className="text-muted-foreground">
            · {formatDate(quote.quoteDate)}
          </span>
        </div>
        <StatusBadge status={quoteBadgeStatus[quote.status]} />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="tabular-nums">{formatCents(centsOf(quote.unitCost))}/unit</span>
        <span
          title="Estimated at the quote's cost and origin under the part's committed HTS — the supplier's claimed HTS is reference only."
          className="text-muted-foreground"
        >
          landed {quote.estimateIncomplete ? "≥ " : ""}
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
        {quote.status === "received" ? (
          <span className="ml-auto flex items-center gap-1.5">
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
          </span>
        ) : null}
      </div>

      {quote.status === "approved" && quote.newerReceivedExists ? (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          A newer quote has been received for this SKU.
        </p>
      ) : null}
      {quote.htsCode ? (
        <p className="text-xs text-muted-foreground">
          Supplier HTS {quote.htsCode} — reference only
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
                        : "Recorded date — no business date on the source"
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

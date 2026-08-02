"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, History, ReceiptText } from "lucide-react";
import { toast } from "sonner";

import { eventMeta } from "@/components/events/event-meta";
import { Money } from "@/components/money";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { PartQuoteRow, PartRow } from "@/lib/db/queries/parts";
import type { BusinessEvent } from "@/lib/events/types";
import { formatCents, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

// The row expansion: quote sheets on the left (~5/12), SKU history on the
// right (~7/12), stacked on narrow screens. Same muted panel treatment as
// the entries expansion.
export function PartExpansion({
  part,
  onAddQuote,
}: {
  part: PartRow;
  onAddQuote: (part: PartRow) => void;
}) {
  return (
    <div className="grid gap-4 bg-muted/30 px-12 py-4 lg:grid-cols-12">
      <div className="lg:col-span-5">
        <QuoteSheetsCard part={part} onAddQuote={onAddQuote} />
      </div>
      <div className="lg:col-span-7">
        <HistoryCard part={part} />
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
          // Actor is free text until auth lands.
          body: JSON.stringify({ action, decidedBy: "Alex" }),
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
          <span>
            Current cost{" "}
            <Money value={part.unitCost} className="text-foreground" />
          </span>
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
            title="Quote cost vs the current official cost/unit"
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

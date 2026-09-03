"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Scale } from "lucide-react";
import { toast } from "sonner";

import { HtsCode } from "@/components/hts-code";
import { Money } from "@/components/money";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PartQuoteRow, PartRow } from "@/lib/db/queries/parts";
import { formatCents, formatDate, formatRate } from "@/lib/format";
import type { CostComponent } from "@/lib/landed-cost/types";
import type { ComparisonOption, QuoteComparison } from "@/lib/quotes/compare";
import { cn } from "@/lib/utils";

// The per-SKU sourcing comparison: every option — the current (part, vendor)
// sources and every quote, whatever its status — priced to a landed cost
// under one HTS basis and today's measures, cheapest first and marked. Each
// row opens to the component stack behind its figure. A part with only
// potential codes (a quote-created SKU the classifier ranked) prices under
// the top candidate, with the rest one switch away.
//
// When a tariff change moved the cheapest option (an open quote_reconsider
// item), the card leads with what moved and lets the human take the cheaper
// quote (the same approve as the Vendors card) or dismiss.

const LANDED_TITLE =
  "Unit cost + duty stack under the basis HTS + nominal MPF/HMF. Freight, insurance & brokerage not included.";

const quoteBadgeStatus: Record<ComparisonOption["status"], string> = {
  current: "current",
  received: "quote_received",
  approved: "approved",
  applied: "applied",
  rejected: "rejected",
  superseded: "superseded",
};

export function CompareCard({
  part,
  busyQuoteId,
  onDecide,
}: {
  part: PartRow;
  busyQuoteId: string | null;
  onDecide: (quote: PartQuoteRow, action: "approve" | "reject") => void;
}) {
  const router = useRouter();
  const primary = part.comparison;
  const [basisDigits, setBasisDigits] = React.useState<string | null>(
    primary.basis.digits,
  );
  const comparison: QuoteComparison =
    basisDigits === primary.basis.digits
      ? primary
      : (part.alternativeComparisons.find(
          (c) => c.basis.digits === basisDigits,
        ) ?? primary);
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const [dismissing, setDismissing] = React.useState(false);

  const quoteById = React.useMemo(
    () => new Map(part.quotes.map((q) => [q.id, q])),
    [part.quotes],
  );
  const reconsider = part.reconsider;
  const beforeByKey = React.useMemo(
    () =>
      new Map(
        (reconsider?.proposal.options ?? []).map((o) => [o.key, o.beforeCents]),
      ),
    [reconsider],
  );

  async function dismiss() {
    if (!reconsider) return;
    setDismissing(true);
    try {
      const res = await fetch(`/api/quote-reconsider/${reconsider.itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dismiss" }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error ?? "Could not dismiss.");
      toast.success(`Sourcing kept for ${part.sku}.`);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not dismiss.");
    } finally {
      setDismissing(false);
    }
  }

  const basisChoices =
    primary.basis.digits === null
      ? []
      : [
          {
            code: primary.basis.code as string,
            digits: primary.basis.digits,
            confidence: primary.basis.confidence,
          },
          ...primary.basis.alternatives,
        ];

  return (
    <div className="rounded-md border bg-background">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-3 py-2">
        <h4 className="flex items-center gap-1.5 text-sm font-medium">
          <Scale className="size-4" /> Landed cost
        </h4>
        <BasisControl
          comparison={comparison}
          choices={basisChoices}
          onChange={setBasisDigits}
        />
      </div>

      {reconsider ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-300 bg-amber-50/60 px-3 py-2 text-sm dark:border-amber-800 dark:bg-amber-950/20">
          <span>
            <span className="font-medium">{reconsider.proposal.cheapest.label}</span>{" "}
            lands {formatCents(reconsider.proposal.savingCents)}/unit below{" "}
            {(reconsider.proposal.chosen ?? reconsider.proposal.previousCheapest)
              ?.label ?? "the previous option"}{" "}
            after {reconsider.proposal.changeLabel}
            <span className="text-muted-foreground">
              {" "}
              · from {formatDate(reconsider.proposal.asOfAfter)}
            </span>
          </span>
          <Button
            variant="outline"
            size="xs"
            disabled={dismissing}
            onClick={(e) => {
              e.stopPropagation();
              void dismiss();
            }}
          >
            Keep current
          </Button>
        </div>
      ) : null}

      {comparison.basis.kind === "none" ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">
          No HTS code to price under yet.
        </p>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th className="w-7" />
              <th className="px-2 py-1.5 text-left font-medium">Vendor</th>
              <th className="px-2 py-1.5 text-left font-medium">Status</th>
              <th className="px-2 py-1.5 text-right font-medium">Cost/unit</th>
              <th className="px-2 py-1.5 text-left font-medium">Origin</th>
              <th className="px-2 py-1.5 text-right font-medium">Duties</th>
              {reconsider ? (
                <th className="px-2 py-1.5 text-right font-medium">Before</th>
              ) : null}
              <th className="px-2 py-1.5 text-right font-medium" title={LANDED_TITLE}>
                Landed/unit
              </th>
              <th className="px-2 py-1.5 text-right font-medium">vs cheapest</th>
              <th className="px-2 py-1.5" />
            </tr>
          </thead>
          <tbody className="divide-y border-t">
            {comparison.options.map((o) => {
              const quote = o.quoteLineId ? quoteById.get(o.quoteLineId) : undefined;
              const open = openKey === o.key;
              return (
                <React.Fragment key={o.key}>
                  <OptionRow
                    option={o}
                    open={open}
                    onToggle={() => setOpenKey(open ? null : o.key)}
                    beforeCents={reconsider ? (beforeByKey.get(o.key) ?? null) : undefined}
                    quote={quote}
                    busy={quote ? busyQuoteId === quote.id : false}
                    onDecide={onDecide}
                  />
                  {open && o.landed ? (
                    <tr className="bg-muted/30">
                      <td />
                      <td colSpan={reconsider ? 9 : 8} className="px-2 py-2">
                        <Breakdown components={o.landed.components} />
                      </td>
                    </tr>
                  ) : null}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BasisControl({
  comparison,
  choices,
  onChange,
}: {
  comparison: QuoteComparison;
  choices: { code: string; digits: string; confidence: number | null }[];
  onChange: (digits: string) => void;
}) {
  const basis = comparison.basis;
  if (basis.kind === "none" || basis.code === null) return null;
  const tag =
    basis.kind === "committed" ? null : basis.kind === "provisional" ? "provisional" : "potential";
  const pct =
    basis.confidence === null ? "" : ` · ${Math.round(basis.confidence * 100)}%`;
  if (choices.length <= 1) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <HtsCode code={basis.code} className="text-foreground" />
        {tag ? (
          <Badge variant="outline" className="font-normal text-muted-foreground">
            {tag}
            {pct}
          </Badge>
        ) : null}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      {tag ? (
        <Badge variant="outline" className="font-normal text-muted-foreground">
          {tag}
        </Badge>
      ) : null}
      <Select value={basis.digits as string} onValueChange={onChange}>
        <SelectTrigger size="sm" className="h-7 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {choices.map((c) => (
            <SelectItem key={c.digits} value={c.digits} className="text-xs">
              {c.code}
              {c.confidence === null ? "" : ` · ${Math.round(c.confidence * 100)}%`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </span>
  );
}

function OptionRow({
  option: o,
  open,
  onToggle,
  beforeCents,
  quote,
  busy,
  onDecide,
}: {
  option: ComparisonOption;
  open: boolean;
  onToggle: () => void;
  /** undefined = no Before column; null = no figure for this row. */
  beforeCents: number | null | undefined;
  quote: PartQuoteRow | undefined;
  busy: boolean;
  onDecide: (quote: PartQuoteRow, action: "approve" | "reject") => void;
}) {
  const dutyCents =
    o.landed === null
      ? null
      : o.landed.components
          .filter((c) => c.kind === "duty")
          .reduce((s, c) => s + (c.amountCents ?? 0), 0);
  const muted = !o.eligible;
  const delta = o.deltaVsCheapestCents;
  return (
    <tr
      className={cn(
        "align-middle",
        o.landed !== null && "cursor-pointer hover:bg-foreground/2",
        muted && "text-muted-foreground",
      )}
      onClick={(e) => {
        e.stopPropagation();
        if (o.landed !== null) onToggle();
      }}
    >
      <td className="py-1.5 pl-1">
        {o.landed !== null ? (
          <span className="text-muted-foreground">
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </span>
        ) : null}
      </td>
      <td className="px-2 py-1.5">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className={cn(!muted && "font-medium")}>
            {o.vendorName ?? "Unknown supplier"}
          </span>
          {o.quoteDate ? (
            <span className="text-xs text-muted-foreground">{formatDate(o.quoteDate)}</span>
          ) : null}
          {o.cheapest ? (
            <Badge
              variant="outline"
              className="border-emerald-500/20 bg-emerald-500/10 font-normal text-emerald-700 dark:text-emerald-400"
            >
              Cheapest
            </Badge>
          ) : null}
        </span>
      </td>
      <td className="px-2 py-1.5">
        <StatusBadge status={quoteBadgeStatus[o.status]} />
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums">
        {o.unitCostCents === null ? "—" : formatCents(o.unitCostCents)}
        {o.currency !== "USD" ? (
          <span className="ml-1 text-xs text-muted-foreground">{o.currency}</span>
        ) : null}
      </td>
      <td className="px-2 py-1.5">{o.countryOfOrigin ?? "—"}</td>
      <td className="px-2 py-1.5 text-right tabular-nums">
        {dutyCents === null ? "—" : `${o.incomplete ? "≥ " : ""}${formatCents(dutyCents)}`}
      </td>
      {beforeCents !== undefined ? (
        <td className="px-2 py-1.5 text-right">
          <Money cents={beforeCents} estimate />
        </td>
      ) : null}
      <td className="px-2 py-1.5 text-right">
        {o.incomplete ? <span className="text-muted-foreground">≥ </span> : null}
        <Money
          cents={o.landedPerUnitCents}
          estimate
          className={cn(!muted && "font-medium text-foreground")}
        />
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums text-xs">
        {delta === null || delta === 0 ? (
          <span className="text-muted-foreground">{delta === 0 ? "—" : ""}</span>
        ) : (
          <span className="text-red-700 dark:text-red-400">+{formatCents(delta)}</span>
        )}
      </td>
      <td className="px-2 py-1.5 text-right">
        {quote && quote.status === "received" ? (
          <span className="flex items-center justify-end gap-1.5">
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
      </td>
    </tr>
  );
}

function Breakdown({ components }: { components: CostComponent[] }) {
  return (
    <div className="flex max-w-md flex-col gap-0.5 text-xs">
      {components.map((c, i) => (
        <div key={i} className="flex items-baseline gap-2" title={c.note}>
          <span className={cn(c.kind === "merchandise" && "font-medium")}>
            {c.label}
          </span>
          {c.rate != null && c.kind !== "duty" ? (
            <span className="text-muted-foreground">{formatRate(c.rate)}</span>
          ) : null}
          <span className="ml-auto tabular-nums">
            {c.amountCents === null ? (
              <span className="text-muted-foreground">not computable</span>
            ) : (
              formatCents(c.amountCents)
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

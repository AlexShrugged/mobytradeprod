"use client";

import { Money } from "@/components/money";
import { SailBasisBadge, type SailBasisValue } from "@/components/sail-basis";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

// Consolidated duties & fees money: the total as a click-open breakdown of
// base duty / additional duties / AD/CVD deposits / MPF / HMF / other fees
// — the 7501's block 40 total in the order the form collects it. Red for
// declared money, muted ~ for estimates (future entries, which estimate
// only duty and MPF/HMF, so the deposit and other-fee rows stay off), with
// the sail grounding and the savings-clause deadline when duty math rested
// on them. Shared by the entries table cell and the entry detail stat
// tile. All money in cents.
export function DutiesPopover({
  total,
  base,
  additional,
  adcvd,
  mpf,
  hmf,
  otherFees,
  estimate = false,
  sailBasis = null,
  deadlineNote = null,
  align = "end",
  className,
}: {
  total: number | null;
  base: number | null;
  additional: number | null;
  adcvd?: number | null;
  mpf: number | null;
  hmf: number | null;
  otherFees?: number | null;
  estimate?: boolean;
  sailBasis?: SailBasisValue | null;
  deadlineNote?: string | null;
  align?: "start" | "center" | "end";
  className?: string;
}) {
  if (total === null) {
    return <span className="tabular-nums text-muted-foreground">—</span>;
  }
  const rows: [string, number | null][] = [
    ["Base duty", base],
    ["Additional duties", additional],
    ...(adcvd !== undefined
      ? [["AD/CVD deposits", adcvd] as [string, number | null]]
      : []),
    ["MPF", mpf],
    ["HMF", hmf],
    ...(otherFees !== undefined
      ? [["Other fees", otherFees] as [string, number | null]]
      : []),
  ];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "cursor-pointer underline-offset-2 hover:underline",
            className,
          )}
          // Lives inside clickable table rows — without this the row's
          // expand handler swallows the click and the popover never opens.
          onClick={(e) => e.stopPropagation()}
        >
          <Money
            cents={total}
            tone={estimate ? "muted" : "duty"}
            estimate={estimate}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        className="w-64 p-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col gap-1.5 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4">
              <span className="text-muted-foreground">{label}</span>
              <Money cents={value} estimate={estimate && value !== null} />
            </div>
          ))}
          <div className="mt-1 flex justify-between gap-4 border-t pt-1.5 font-medium">
            <span>
              {estimate ? "Est. duties & fees" : "Total duties & fees"}
            </span>
            <Money cents={total} estimate={estimate} className="text-foreground" />
          </div>
          {estimate ? (
            <p className="text-xs text-muted-foreground">
              Estimated from PO prices, catalog codes, and nominal MPF/HMF
              rates.
            </p>
          ) : null}
          {sailBasis ? (
            <div>
              <SailBasisBadge basis={sailBasis} />
            </div>
          ) : null}
          {deadlineNote ? (
            <p
              className="text-xs text-amber-700 dark:text-amber-400"
              title={deadlineNote}
            >
              {deadlineNote}
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

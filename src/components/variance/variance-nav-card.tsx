import Link from "next/link";

import { StatusBadge } from "@/components/status-badge";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { VarianceSiblingAlert } from "@/lib/db/queries/variance";
import {
  pairSiblingAlerts,
  unitIds,
  unitStatus,
} from "@/lib/variance/grouping";
import { formatCents } from "@/lib/format";
import { cn } from "@/lib/utils";

// The line's issue navigator, one item per DECIDABLE UNIT: a rate mismatch
// carries its duty-amount twin as a nested consequence (same charge, same
// dollars — never separately decidable), everything else stands alone. Each
// item is a plain link to its primary's page — the selected issue is the
// URL — so Accept/Dismiss re-renders carry the accepted (green, dimmed) and
// dismissed (struck, dimmed) states with no client state. The CURRENT item
// renders as a div, not a link (it IS the page, and it hosts the `actions`
// buttons — interactive content can't nest inside an anchor). Class order
// matters below: cn() is twMerge-based, so the status backgrounds listed
// after the current-item classes win when both apply (an accepted item you
// navigate back to stays green, keeps the ring). Links REPLACE history —
// hopping between a line's issues is one review flow, so browser back
// exits to wherever the flow was entered — and carry ?from=entry forward
// when the flow began on the entry page.
export function VarianceNavCard({
  siblings,
  currentId,
  fromEntry = false,
  actions = null,
}: {
  siblings: VarianceSiblingAlert[];
  currentId: string;
  fromEntry?: boolean;
  /** Decision buttons rendered inside the current item — a second home for
   *  Accept/Dismiss, always in view beside long diff tables. */
  actions?: React.ReactNode;
}) {
  const units = pairSiblingAlerts(siblings);
  const position =
    units.findIndex((u) => unitIds(u).includes(currentId)) + 1;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Variance</CardTitle>
        {position > 0 ? (
          <CardAction className="text-sm text-muted-foreground tabular-nums">
            {position} of {units.length}
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {units.map((u) => {
          const status = unitStatus(u);
          const current = unitIds(u).includes(currentId);
          const impactCents =
            u.primary.impactCents ?? u.consequence?.impactCents ?? null;
          const direction =
            u.primary.impactCents !== null
              ? u.primary.direction
              : (u.consequence?.direction ?? null);
          // Decided items dim — but on the CURRENT item the dimming moves
          // off the container onto the body wrapper below, so the hosted
          // action buttons (Reopen) stay full-strength: a child can never
          // exceed its parent's opacity.
          const itemClassName = cn(
            "block rounded-md border p-3 transition-colors",
            status === "open" && !current && "hover:bg-muted/50",
            current && "border-ring bg-muted ring-1 ring-ring/40",
            status === "resolved" &&
              "bg-emerald-50/50 dark:bg-emerald-950/20",
            status !== "open" && !current && "opacity-60",
          );
          const body = (
            <>
              <div className="flex items-center justify-between gap-2">
                <StatusBadge status={u.primary.alertType} />
                {impactCents !== null ? (
                  <span
                    className={cn(
                      "text-xs font-medium tabular-nums",
                      direction === "recoverable" &&
                        "text-emerald-700 dark:text-emerald-400",
                      direction === "exposure" &&
                        "text-red-700 dark:text-red-400",
                      direction === null && "text-muted-foreground",
                    )}
                  >
                    {direction === "recoverable"
                      ? "+"
                      : direction === "exposure"
                        ? "−"
                        : ""}
                    {formatCents(Math.abs(impactCents))}
                  </span>
                ) : null}
              </div>
              <p
                className={cn(
                  "mt-1.5 text-xs text-muted-foreground",
                  status === "dismissed" && "line-through",
                )}
              >
                {u.primary.message}
              </p>
              {u.consequence ? (
                <div className="mt-2 border-l-2 border-border pl-2.5">
                  <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Consequence · follows the rate
                  </div>
                  <p
                    className={cn(
                      "mt-0.5 text-xs text-muted-foreground",
                      status === "dismissed" && "line-through",
                    )}
                  >
                    {u.consequence.message}
                  </p>
                </div>
              ) : null}
            </>
          );
          if (current) {
            return (
              <div
                key={u.primary.id}
                aria-current="page"
                className={itemClassName}
              >
                <div className={cn(status !== "open" && "opacity-60")}>
                  {body}
                </div>
                {actions ? <div className="mt-3">{actions}</div> : null}
              </div>
            );
          }
          return (
            <Link
              key={u.primary.id}
              href={`/variance/${u.primary.id}${fromEntry ? "?from=entry" : ""}`}
              replace
              // Full prefetch: the page is force-dynamic, so the default
              // only prefetches the loading skeleton — this fetches each
              // sibling's whole payload once visible, making hops between
              // a line's issues instant. Decisions router.refresh(), which
              // re-fetches, so prefetched siblings never show stale states.
              prefetch={true}
              className={itemClassName}
            >
              {body}
            </Link>
          );
        })}
      </CardContent>
    </Card>
  );
}

import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";

// How a sail date was resolved (mirrors duty/sail.ts SailBasis): "exact" =
// BOL on-board notation; "estimated" = ETD fallback; "assumed" = no date at
// all, resolved conservatively toward duty owed.
export type SailBasisValue = "exact" | "estimated" | "assumed";

/** Table cell for a shipment's sail date: exact date, muted ~ETD, or —. */
export function SailDateCell({
  sailedOnBoardDate,
  etd,
}: {
  sailedOnBoardDate: string | null;
  etd: string | null;
}) {
  if (sailedOnBoardDate) return <>{formatDate(sailedOnBoardDate)}</>;
  if (etd) {
    return (
      <span
        className="text-muted-foreground"
        title="Estimated: no on-board date yet, showing ETD"
      >
        ~{formatDate(etd)}
      </span>
    );
  }
  return <>—</>;
}

const basisMeta: Record<SailBasisValue, { label: string; title: string }> = {
  exact: {
    label: "sailed date: exact",
    title: "From the BOL's shipped-on-board notation.",
  },
  estimated: {
    label: "sailed date: estimated",
    title: "No on-board date yet; sail-conditioned duties use the ETD.",
  },
  assumed: {
    label: "sailed date: assumed",
    title: "No sail date; resolved toward duty owed until a BOL arrives.",
  },
};

/** Shown wherever duty math rested on a sail condition. */
export function SailBasisBadge({ basis }: { basis: SailBasisValue | null }) {
  if (!basis || basis === "exact") return null;
  const meta = basisMeta[basis];
  return (
    <Badge
      variant="outline"
      className="border-amber-500/20 bg-amber-500/10 font-normal text-amber-700 dark:text-amber-400"
      title={meta.title}
    >
      {meta.label}
    </Badge>
  );
}

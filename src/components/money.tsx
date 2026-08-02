import { cn } from "@/lib/utils";
import { formatCents, formatMoney } from "@/lib/format";

// The one money renderer: tabular numerals, red for duties owed, green for
// refunds, and a muted ~ prefix for estimates (future entries, quote landed
// costs) so estimated money never reads as fact.
export function Money({
  value,
  cents,
  tone = "default",
  estimate = false,
  className,
}: {
  value?: string | number | null;
  cents?: number | null;
  tone?: "default" | "duty" | "refund" | "muted";
  estimate?: boolean;
  className?: string;
}) {
  const text = cents !== undefined ? formatCents(cents) : formatMoney(value);
  if (text === "—") {
    return <span className={cn("tabular-nums text-muted-foreground", className)}>—</span>;
  }
  return (
    <span
      className={cn(
        "tabular-nums",
        {
          "text-red-700 dark:text-red-400": tone === "duty",
          "text-emerald-700 dark:text-emerald-400": tone === "refund",
          "text-muted-foreground": tone === "muted" || estimate,
        },
        className,
      )}
      title={estimate ? "Estimate" : undefined}
    >
      {estimate ? `~${text}` : text}
    </span>
  );
}

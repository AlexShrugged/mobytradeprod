import { cn } from "@/lib/utils";

// The KPI tile used on Entries and detail pages. Tone colors the value only —
// red for duties owed, green for refunds, amber for attention counts.
export function StatTile({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: "default" | "red" | "green" | "amber";
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={cn("mt-1 text-xl font-semibold tabular-nums", {
          "text-red-700 dark:text-red-400": tone === "red",
          "text-emerald-700 dark:text-emerald-400": tone === "green",
          "text-amber-700 dark:text-amber-400": tone === "amber",
        })}
      >
        {value}
      </div>
      {hint ? (
        <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
      ) : null}
    </div>
  );
}

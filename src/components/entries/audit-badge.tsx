import { AlertTriangle, Check, CircleAlert, Info } from "lucide-react";

import { cn } from "@/lib/utils";

export type OpenAlertCounts = { error: number; warning: number; info: number };

// Compact audit summary for a table row: the worst open severity with its
// count, a bare green check when audited with no findings — the same mark the
// line-items table uses for a clean line — em dash when there is nothing to
// audit yet.
export function AuditBadge({
  counts,
  hasData,
}: {
  counts: OpenAlertCounts;
  hasData: boolean;
}) {
  if (!hasData) {
    return <span className="text-muted-foreground">—</span>;
  }
  const total = counts.error + counts.warning + counts.info;
  if (total === 0) {
    return (
      <span title="No open findings on this entry">
        <Check
          className="size-4 text-emerald-600 dark:text-emerald-400"
          aria-label="No open findings on this entry"
        />
      </span>
    );
  }
  const [Icon, cls] =
    counts.error > 0
      ? [CircleAlert, "text-red-700 dark:text-red-400"]
      : counts.warning > 0
        ? [AlertTriangle, "text-amber-700 dark:text-amber-400"]
        : [Info, "text-blue-700 dark:text-blue-400"];
  return (
    <span className={cn("inline-flex items-center gap-1 tabular-nums", cls)}>
      <Icon className="size-3.5" /> {total}
    </span>
  );
}

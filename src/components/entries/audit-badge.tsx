import { AlertTriangle, CircleAlert, Info, ShieldCheck } from "lucide-react";

import { cn } from "@/lib/utils";

export type OpenAlertCounts = { error: number; warning: number; info: number };

// Compact audit summary for a table row: the worst open severity with its
// count, "clear" when audited with no findings, em dash when there is nothing
// to audit yet.
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
      <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
        <ShieldCheck className="size-3.5" /> clear
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

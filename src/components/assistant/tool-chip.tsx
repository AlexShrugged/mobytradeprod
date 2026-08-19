import { Check, Loader2, X } from "lucide-react";

import { cn } from "@/lib/utils";

// One tool call, collapsed to a chip: "Variance queue (open) · 12 rows".
// ok null = still running. detail = hover text (a condensed run's per-call
// lines).
export function ToolChip({
  summary,
  result,
  ok,
  detail,
}: {
  summary: string;
  result: string | null;
  ok: boolean | null;
  detail?: string;
}) {
  return (
    <span
      title={detail}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border bg-muted/50 px-2.5 py-0.5 text-xs text-muted-foreground",
        ok === false && "border-red-300/60 text-red-700 dark:text-red-400",
      )}
    >
      {ok === null ? (
        <Loader2 className="size-3 animate-spin" />
      ) : ok ? (
        <Check className="size-3" />
      ) : (
        <X className="size-3" />
      )}
      <span className="max-w-72 truncate">
        {summary}
        {result && ok !== false ? ` · ${result}` : ""}
      </span>
    </span>
  );
}
